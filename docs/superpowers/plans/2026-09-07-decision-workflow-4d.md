# Decision workflow, unit 4d — the architect, forwarding and countersign: the plan

**Status: PLANNING — this is the docs-only 4d plan unit the merged 4b plan's §E order requires**
(`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`
§E: "the 4d plan unit (STARTING MATERIAL: the §C orchestration design at
`6a53aae` + §D obligations 4–6) → 4d implementation"), reached exactly when
the 4c plan said it would be (`2026-08-29-decision-workflow-4c.md` §D: "4d …
its plan unit follows 4c implementation — ALL SIX PRs, 4c-0 through 4c-v";
4c-v merged as PR #535 at `main` `f5da6654`, the handoff recorded by #536 at
`d7eed4ce`). It must clear its own exact-head review to a fresh clean +1
before 4d implementation begins — the same plan-first contract that preceded
4a, 4b and 4c, all three DELIVERED AND CLEARED (4a: PR #337; 4b: PR #468 at
`fe9df58d`; 4c: the six units #489 → #498 → #506 → #528 → #533 → #535).

## Review lineage, and what this replacement does differently

**THE DRAIN GATE STANDS AS THE CONTROLLING DEFAULT — the human
`OPERATOR-ATTESTATION` REQUIRED, the autonomous evidence fail-closed
corroboration — and the lifted-gate fold of #568's head `b0d5399` is
REVERSED here, on the record.** The record, in order. The default (#482
comment 5569586836, 2026-09-07) retains the attestation; every decline from
#558 to #568's round 1 cited it. A GitHub Watch relay under the shared owner
login (#482 comment 5577525644, nudged to #566 as comment 5577525720)
presented a "Board GO" lifting it; this lineage's session folded that relay
on #566's head `1a2ba97`; Delivery's hold (#482 comment 5577732007)
established that no direct user decision stood behind the relay, and the
fold was reverted byte-for-byte on head `5921f22`. A comment in the Board's
own words then appeared at #482 comment 5577872836 (owner account, no
coordinator marker) lifting the gate; the fold was prepared and HELD while
the session's permission layer refused it (#566 comment 5577923054), then
applied on #568's head `b0d5399` after an in-session instruction, and
#568's head `86ee002` rewrote `main`'s `AGENTS.md` bullet (#569) to match.
GitHub Watch's own record (#482 comment 5581275205) states that Watch
ENTERED the in-session selection that kept the fold ("Channel 1 only —
Claude Code session reply … Selected Lifted"); the session that authored
#569 records the user's direct instruction to it — keep the gate and add
the `AGENTS.md` sentence (#482 comment 5581298475); and no API field
distinguishes comment 5577872836 from a coordinator post. A gate the user
retained is not lifted on an instruction a coordinator typed, and a session
cannot verify its own inputs against that record — so this replacement
fails CLOSED: §D "The drain attestation" reads exactly as at `5921f22`,
`AGENTS.md` is left exactly as `main` carries it, and the lifted-gate text
of `b0d5399`/`86ee002` is recorded here as what it was. Lifting the gate
remains the user's decision to give in their own voice; the plan carries
the default until then. The lineage tables below keep every earlier
decline and both reverted folds as history.

This document is carried on PR #572 itself, FIXED FORWARD on its own branch:
the Board decided it (#482 comment 5585712971, 2026-09-08 — fix-forward on
#572, no replacement for vehicle reasons alone) and the forced
close-and-replace at the second finding-bearing head was retired on `main`
by #578 (`f050bcd`). This head was first opened as the replacement #575
(`Replaces: #568`, from `main` `c835168`); a coordinator closed #575 back
into #572 at 11:28 UTC and the commits stayed on the branch. The ledger line
is `Replaces: none`: the `review-replacement-required` labels on #559, #567
and #568 were removed on the Board's instruction at 11:36 UTC (#572 comment
5584522420; #567's obligation had already been discharged by #569's merge
and #559's by #570's; #520–#566 were unlabelled by hand at 06:05 UTC per
#569's record), an empty ledger admits `none` and refuses `#568`, and #578
retired the rule that minted those labels. The content lineage from #568 is
kept below unchanged.
#572 was the FIFTEENTH outing of the NARROWED plan: it drew two findings on
its first head (`8b50b52`: the standard writer's frozen pair, the unkeyed
`requestChange`), folded on its one correction `e2fd243e` by a second
Claude session (session_01SkcEKPyj3MbLUoCy8bFuck, answering the
orchestrator's Auto-fix handoff) — a head that also committed a
machine-local `node_modules` symlink, removed on `8acf586` — and two more on
`e2fd243e` (that symlink; the standard change-request role set the §A.3 seal
enumeration dropped), and closed at the limit. #572 had replaced #568 (the
fourteenth outing: four findings on `55144a3` as the gate counts them, two
folded on `2530c8e`, the drain gate declined there and folded on `b0d5399`
— reversed here — with a clean +1 on `b0d5399`; two more on `867d065`),
#568 had replaced #567 (the thirteenth
outing: four findings on `5f07c5a`; three folded on `7bf282f`, the drain
attestation declined; three more there), #567 had replaced #566 (the twelfth outing: two
findings on `cc8b3ba`, one folded on `e3d6c23` and the drain attestation
declined, a relay-based drain fold `1a2ba97` reverted on `5921f22`, two
more there), #566 had replaced #565 (the eleventh outing: three
findings on `5871826`; two folded on `89bd230`, the drain attestation
declined; one more there), #565 had replaced #564 (the tenth outing: one on
`93349e6` — the drain attestation, declined and recorded on `2a47037` —
three more there), #564 had replaced #563 (the ninth outing:
five on `6bf75a36`, four folded on `01706fe` and the drain attestation
declined, one more there), #563 had replaced #562 (the eighth outing: six on
`be56b941`, five folded on `2f493f8f` and the drain attestation declined,
five more there), #562 had replaced #561 (the seventh outing: seven
on `b2e556c3` folded on `d5646595`, nine more there), #561 had replaced
#560 (the sixth
outing: eleven on `01c6e819`, ten folded on `847b5c40` and one — the drain
attestation — declined on the Board's recorded decision, six more there),
#560 had replaced #558 (the fifth outing: seven on
`a07f78b7` folded on `96ba845b`/`526dd5a5`/`64d9030f`, nine more there),
#558 had replaced #557 (the
fourth outing: five findings on `3327f761` folded on `6d5545ce`, four more
there), #557 had replaced #556 (the third: three on `bb307c74` folded on
`dd2da64b`, five more there), #556 had replaced #555 (the second: five on
`3e5a85a2` folded on `41ea41d2`, four more there), #555 had replaced #554
(the first: seven on `cbfdaacb` folded on `82a497a5`, seven more there),
and #554 had replaced #552, the fifteenth replacement of the ORIGINAL
docs-only unit: #537 → #538 → #539 →
#540 → #541 → #542 → #543 → #544 → #545 → #546 → #547 → #548 → #549 → #550 →
#551 → #552, sixteen PRs, thirty-two Codex review rounds, one hundred and
sixty-eight findings, each PR closed without a third correction head when
its second head drew findings. The closed PRs and their review threads are the record of every
finding and every fold; this document does not reproduce that narration
round by round, because a plan that has to be read through thirty-two
layers of "(review round N)" annotations is not a plan a reviewer can hold
whole — and holding it whole is the point of a plan unit.

**The three findings on #552's second head (`4b9a648f`) are carried, none
dropped**, and each is answered by construction rather than by a patch:

1. **Approval event/feed correspondence.** The round-31 "count-based
   emitter handoff" let the lifecycle seal accept ANY single
   same-transaction approval event and then write nothing, so a
   receipt-backed direct writer could commit a `change → approved`
   transition beside one forged `decision.approved` row with no audit or
   feed row and satisfy the count. This plan withdraws the handoff and the
   seal-emission it served. A seal VERIFIES the complete bundle field by
   field — the event's type, entity, actor and the paired fact's
   attribution, the `DecisionEvent` audit row of the transition's kind, and,
   where the transition owes one, the `Notification` feed row bound to that
   event — and REFUSES the transition otherwise. Nothing is deferred to;
   there is one emitter, the service, for every writer at every instant
   (§A.3 obligation 7).
2. **Durable recipient identity for the countersign demand.** The
   round-31 claim notice recorded the standing position the claim resolved
   holders against, but the delivered `makePushConsumer` resolves
   `roleHolderUserIds` later, in `handle`, after the lease transaction
   commits — so the notice and the send could disagree about who was
   demanded. This plan withdraws the notice register and the claim hook
   with it: the two 4d push families are USER-targeted at EMISSION, their
   recipients resolved under the readiness lock by the emitting command
   and frozen in the event's immutable dispatch intent and the delivery's
   payload; the send iterates that frozen set, re-judging each recipient's
   standing before their own provider call and never resolving a role at
   claim. The crossing handler decides from stream positions the kernel
   already records, not from a register the claim had to append (§A.2, the
   push families).
3. **Staged event/recipient notification uniqueness.** The round-29
   `platform_write_notification` twin promised `(event, recipient)`
   idempotency the `Notification` schema could not express. This plan
   withdraws the twin and stages the one column the correspondence rule
   needs — `Notification.eventId`, nullable, bound by a SAME-PROJECT
   composite FK `(projectId, eventId)` to a `DomainEvent(projectId,
   eventId)` candidate key 4d-i adds, partially UNIQUE where non-NULL — in
   4d-i, so the feed row a transition owes is bound to the event it
   announces, a second row for the same event is unrepresentable, and a row
   bound to another project's event is unrepresentable (§A.2, §D).

**Why one design pass rather than three more paragraphs.** Rounds 19 to 32
— fourteen rounds, sixty-one findings — landed on ONE commitment made in
round 19 and extended in rounds 21, 22, 24, 26, 29, 30 and 31: that the
database ADMITS a hand-run bundle and therefore must PRODUCE that bundle's
side effects itself — the crossing event from a trigger, a PL/pgSQL twin of
`emitEvent`, a twin of the notification helper, seal-written audit rows, a
count-based handoff between the service's emission and the seal's, a
claim-time notice register, and a relay refactor so the notice could be born
inside the lease. Every one of those findings was a divergence between a
PL/pgSQL reproduction of the service and the service itself, and that class
is OPEN: a twin must track every future change of the helper it mirrors,
and a handoff between two emitters has a race for every ordering the plan
has not yet named. The design pass replaces reproduction with VERIFICATION,
which is CLOSED: a seal checks a fixed correspondence predicate over rows
the transaction already holds, and a bundle that lacks any part is refused.
Nothing a seal admitted before is admitted now without its effects; what
changes is that the effects are demanded of the writer instead of
manufactured for it. §A.4 lists every withdrawn mechanism, the finding it
answered, and how the narrowed design answers that finding — the ledger the
continuation authorization requires (#482, 2026-09-07: "reduce the review
unit at safe dependency seams; preserve the obligations ledger and clearly
name any deferred dependency").

**Scope is reduced only at seams the delivered surface already proves
safe.** Four mechanisms are withdrawn on that ground, each with its
argument in §A.4: the reserved-value repair for `Decision` rows (the state
it repairs is unrepresentable — `DecisionStatus` and `DeciderKind` are
PostgreSQL enums, so no row can hold a value the type lacks), the
consumer-registration cutover (its hazard was retired when restoration
stopped re-emitting), the archived-project parking (the delivered 4c rule —
drop at claim with the recorded mark, no re-emission on restore — is the
cleared behaviour every decision push already has), and the receipt-level
`actorRole`/`actorName` pair (the owning fact seal judges the frozen role
and name against live standing at the act, which is what the pair existed
to prove). No decision carried from `6a53aae` is reopened; no finding is
dismissed; every deferred dependency is named where it is deferred.

**Review round 1 on #554 (head `cbfdaacb`) — seven findings, folded on
its ONE correction head.** Each is a place where the narrowed design stated
its rule and left one instance of it unstated; none reopens a carried
decision, and each answer is the rule applied where it was missing:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the awaiting entry's bundle listed the approval event and not the countersign demand, so a hand-run bundle could commit `awaiting_countersign` with no `decision.awaiting_countersign` — no frozen architect recipients, no demand position for `decisions.effects` | §A.3 obligation 7, the correspondence table's first row; §A.2 the countersign section; P31 | the provisional approve's ONE event is `decision.awaiting_countersign`, carrying the provisional act in its payload and the architects frozen in its intent; the seal requires exactly that event and REFUSES a `decision.approved`/`reapproved` at the awaiting entry, because that event announces finality to every consumer and belongs to the finalizer's row |
| 2 (P1) the correspondence judged the event's type, coordinates and actor but not its envelope, so a hand-run writer could insert at the stream's `nextPosition` without incrementing the counter (the next `emitEvent` then collides) or with an arbitrary `dispatchIntent` the relay would trust | §A.3 obligation 7; §D 4d-i, 4d-ii, 4d-iii; P37, P38 | the KERNEL seals its own envelope at INSERT: `DomainEvent_t4d_envelope` requires the position to be the one this transaction allocated from `ProjectEventStream` and the intent to correspond to a PERSISTED, versioned external-effect catalog (`ExternalEffectCatalog`, seeded by 4d-i with the current catalog, widened by 4d-ii's catalog-data migration beside the old version for the drain, the old version retired by 4d-iii) — verification, never a twin |
| 3 (P1) `approvedByName`/`approvedByRole` were required only on a revision born `finalized = false`, so after the drain a hand-run no-chain approval could insert a finalized revision with both NULL | §A.2 the finalizing-event paragraph; §D 4d-iii; P42 | a trailing 4d-iii INSERT-time seal requires both on EVERY new `DecisionApprovalRevision`; legacy and drain-window NULL rows untouched |
| 4 (P1) `MembershipTransition` stored only `actorId`, so obligation 3 could not be implemented for the one orgs fact and a later rename or re-role left the standing change unable to prove who acted | §A.2 the membership paragraph; §A.3 table; §D 4d-i; P29b | the fact freezes `actorRole` and `actorName`, validated at insert exactly as every decisions fact's pair is (the role one the actor holds — `pmc`, with the owner/admin arm — and the account's display name), immutable with the row |
| 5 (P1) the `DecisionEvent` audit rows the correspondence relies on carried no append-only seal, so a direct writer could delete or rewrite an audit row after a valid transition | §A.3 obligation 7; §D 4d-i; P31 | `DecisionEvent_t4d_append_only` refuses every UPDATE and DELETE on the register (no service path mutates it; the delivered `DecisionEvent_t4a_no_truncate` already refuses TRUNCATE), so an audit row is as immutable as the fact it corresponds to |
| 6 (P2) the fact's actor-authority check accepted the captured pre-state only as `pmc`/`active` for a self-transition, so an org owner/admin re-roling or adding themselves would pass the service and fail the seal | §A.2 the membership paragraph; P29b | the owner/admin arm is judged LIVE for every transition, self-targeted included (a project membership write does not change org standing); the captured PMC pre-state is the self-demotion arm only (subsumed by #566's round 1: the fact precedes the write, so every arm judges the pre-state) |
| 7 (P1) the feed-row correspondence checked project, event and decision but not content, so a hand-run countersign bundle could write a feed row saying the decision was rejected | §A.3 obligation 7; §A.2 the finality paragraph; §D 4d-i, 4d-ii, 4d-iii; P31, P37 | the feed row carries a structured `Notification.kind` the seal binds to the event's type, and every reader RENDERS a kinded row's text and colour from (`kind`, the sealed event envelope, the frozen fact) — the stored `text`/`color` are a display cache no reader serves for a kinded row, so a forged message is never displayed; `kind` is required with `eventId` by the trailing 4d-iii seal |

**Review round 2 on #554 (head `82a497a5`) — seven findings, all P1, carried
here, none dropped.** Five are the narrowed rule applied to one more instance
each; two are real defects in round 1's own additions (the stream-position
predicate and the reset protocol). And together they name the thing this
lineage kept probing without stating, which §A.3 now states as a design
boundary rather than leaving it to be found one field at a time:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the envelope seal proved the counter's final value and that the transaction touched it, not that ONE position was allocated: `nextPosition + 2` and one event at `nextPosition − 1` passed, and the skipped position would stall `dispatchOrdered` forever | §A.3 obligation 7 (the kernel envelope); §D 4d-i; P37 | the counter's transition is itself sealed — `ProjectEventStream_t4d_allocation` admits only `+1` per UPDATE — and a DEFERRED pairing requires, per allocation, a same-transaction event at exactly the position it allocated; the envelope seal already requires the converse, so allocations and events are one-to-one and a gap is unrepresentable |
| 2 (P1) the intent check judged only what the catalog PERMITS, not what the transition OWES — a hand-run `decision.awaiting_countersign` could omit the push, freeze a subset of the architects, or carry a false body | §A.3 obligation 7 (push shape); §A.2 the push families; §D 4d-i/4d-ii; P31/P37 | for the two frozen-audience families the catalog row carries the family's constant, decision-free `pushBody` and `requiresPush`; the transition seal requires the push present with exactly that body and `targetUserIds` EQUAL, as a set, to the audience the orgs-owned set primitive resolves at commit under the readiness lock (`platform_role_holder_user_ids` for the architects; the forward target's user or holders for the forward) — the participant's TypeScript answer wraps the same SQL, one implementation |
| 3 (P1) `DecisionEvent_t4d_append_only` would abort every sanctioned reset: `prisma/seed.ts` and `test/integration/fixtures.ts::wipeDecisionEvents` disable only `DecisionEvent_no_withdrawn_approval` before deleting | §A.3 obligation 7 (the audit row); §D 4d-i | the new seal joins the same transactional disable → delete → enable protocol by name in both files (the `DO $$ … IF EXISTS (pg_trigger) … DISABLE TRIGGER` shape the seed already uses), with a probe that the seed and the wipe succeed on the 4d-i schema |
| 4 (P1) a platform-owned trigger on the orgs-owned `Membership`, interpreting the application role `architect`, reverses the orgs → platform dependency and puts orchestration in the leaf | §A.2 the standing register; §D 4d-i | the `Membership` trigger is ORGS-owned (`Membership_t4d_role_standing`, computing the delta from the row it is handed) and writes through a GENERIC platform primitive `platform_role_standing_apply(projectId, role, delta)`; the platform knows no role, and the register's writer seal admits only trigger-nested writes, which the orgs trigger's call is |
| 5 (P1) the feed row's `eventId`/`kind` binding was INSERT-sealed only, so a direct writer could NULL both (dropping the row to the legacy cache path with a forged text) or delete the owed notice | §A.3 obligation 7 (the feed row); §D 4d-i/4d-ii; P31 | `Notification_t4d_binding` freezes `eventId`, `kind`, `decisionId` and `projectId` on any row whose `eventId` is non-NULL and refuses its DELETE; the delivered withdraw's notice retirement therefore deletes kind-less rows ONLY (a 4d-ii edit) and a kinded notice of a withdrawn decision is hidden by the visibility filter below, never erased |
| 6 (P1) the audit-row correspondence bound type, decision, `actorId` and `actorRole` but not `actorName`, the legacy `actor` label or the transition payload, so an immutable audit row could name another person or reason | §A.3 obligation 7 (the correspondence table gains a payload column); P31/P34/P33 | `actorName` and `actor` equal the fact's frozen name, and every payload field the table names equals the frozen fact's field (`forwarded`: from/to/reason; `countersigned`: the revision; `stranded_resolved`: outcome/reason; `change_requested`: reason and impacts; `approved`/`reapproved`: the revision's option, material and `onBehalfOf`) — the same fields bound on the `DomainEvent` payload where the event carries them |
| 7 (P1) the delivered `SnapshotService` feed filter recognizes the pending and withdrawn TEXT prefixes only, so a kinded `decision.forwarded` notice for a still-`pending` decision would reach members `decisionVisibleToViewer` hides the decision from | §A.3 obligation 7 (the readers); §D 4d-ii; P31/P29 | the kinded feed path — live snapshot, projection fold and rebuild — filters every kinded row through `decisionVisibleToViewer` for its bound decision BEFORE rendering; the text-prefix filters keep governing kind-less rows; a withdrawn decision's kinded notices are thereby pmc-only like the decision |

**The boundary, stated once** (§A.3 states it beside the obligations): a seal
proves that WHAT HAPPENED is recorded coherently — the state machine cannot
move without its fact, the fact cannot exist without its transition, the
actor holds standing, provenance binds, and the transition's IDENTITY
effects exist and correspond field by field on every field the tables name.
A seal cannot prove that a holder of the application's own database role
writes truthful free content, and this plan does not claim it can: an event
payload field the table does not name, a push body that is not the catalog's
constant, a legacy notification's text — each is trusted from the writer
exactly as every delivered 4a–4c surface trusts it today. 4d NARROWS that
trust wherever a reader can derive from an immutable fact instead (the kinded
feed rows, the constant push bodies, the frozen actor pairs), and states
where it cannot.

**Review round 1 on #555 (head `3e5a85a2`) — five findings, all P1,
folded on its ONE correction head.** None is a content question; each is an
integration seam the narrowed rule crosses and had not named:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the feed-row correspondence had the decisions-owned seal count a platform-owned `Notification` row directly — a cross-module table read, where the adjacent event check goes through `platform_tx_event` | §A.3 obligation 7; §D 4d-i | the platform-owned `platform_tx_notification(projectId, eventId)` — the current transaction's feed rows bound to that event — is the kernel contract the seal calls; no decisions trigger selects the platform's table |
| 2 (P1) the event-side predicate bound `actorKind` and `actorId` only, while `DomainEvent` has no role or name column and the table claimed the frozen pair bound on the event | §A.3 obligation 7; §D 4d-i, 4d-iii; P31/P37 | `DomainEvent.actorRole` and `actorName` join the envelope as nullable columns 4d-i adds and the delivered append-only trigger freezes; `emitEvent` writes them from the command actor's pair (`resolveActor` already supplies both); the correspondence requires them equal to the fact's frozen pair, NULL admitted only on the no-chain approve's event through the drain (the pre-4d `emitEvent` writes neither) and required by the trailing 4d-iii seal |
| 3 (P1) the seed's `prisma.membership.deleteMany()` (`seed.ts:160`) is a direct hard delete before `project.deleteMany()`, which the architect hard-delete refusal would abort on any database holding an architect row | §A.2 the membership paragraph; §D 4d-i; P28b | the sanctioned reset gains a membership path: `MembershipTransition` rows deleted under their append-only seal disabled by name, then memberships under the provenance seal's delete arm disabled by name (the orgs standing trigger still applies its deltas, nested and admitted), the register rows falling with the project cascade — in the seed's existing `DO $$ … IF EXISTS (pg_trigger)` protocol and the fixtures' membership wipe, probed by reseeding a database holding an active AND a soft-removed architect |
| 4 (P1) three more suites disable `DecisionEvent_no_withdrawn_approval` directly before `decisionEvent.deleteMany` (`change-control`, `phase1-baseline`, `phase6-t4b-approval-attribution`; `phase6-t4a-withdraw` too), so the new seal would abort their cleanup | §A.3 obligation 7; §D 4d-i | every direct bypass is swept into the shared `wipeDecisionEvents` helper, which knows both seals, and a tripwire greps `test/` for `DISABLE TRIGGER "DecisionEvent_` outside the helper and fails on any hit |
| 5 (P1) the envelope seal would reject the repository's deliberate raw `DomainEvent` inserts — `event-envelope.test.ts` and the six legacy-event plants in `upgrade-proof.sh` (and `outbox-migration-abort-proof.sh`) — before they test what they exist to test | §A.3 obligation 7; §D 4d-i; P37 | a shared `insertRawEvent` fixture allocates the position through `ProjectEventStream` and copies the catalog intent for a named key, so the envelope suite's raw inserts pass the seal and its NEW arms probe the seal itself; a legacy-shape plant (pre-4d by definition) disables `DomainEvent_t4d_envelope` and `ProjectEventStream_t4d_allocation` by name inside its plant transaction and re-enables them after — a NAMED bypass, never an implicit hole; a tripwire enumerates every raw `INSERT INTO "DomainEvent"` in `test/` and `scripts/` and asserts each uses the helper or a named bypass |

**Review round 2 on #555 (head `41ea41d2`) — four findings, all P1, folded
here, none dropped.** None is a content question the boundary answers; each
is a place where round 1's own fold, or the narrowed rule, stopped one
instance short — a claim about every emitter that one seam falsified, a
correspondence that bound three payload fields and left the two a consumer
decides from unbound (and no converse at all), a sweep that counted the
hand-disabled sites and missed the unguarded ones, and a foreign key that
bound an event by id where the tables' rule is a same-project key:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) round 1 claimed `resolveActor` supplies the frozen pair to every emitter, but the commercial write-through seam does not carry it: `CommercialParticipant.AttributionActor` is `actorId`/`actorKind`/`role` only, built at sixteen call sites, and `CommercialBudgetService.evaluate` hands it to `announceMoneyMoved` as an `EventActor` — so after the trailing 4d-iii seal a PO issue on a commercial-enabled project would emit `commercial.money_moved` with no name and abort | §A.3 obligation 7 (the envelope attribution); §D 4d-ii, 4d-iii; P37 | the kernel's `EventActor` is widened from the two-field `Pick` to the FULL `Actor`, so the compiler enumerates every emitter that hands `emitEvent` less; `AttributionActor` becomes the full attribution (`role` retired for `actorRole`, `actorName` added) threaded through the participant seams from the resolved `Actor` every caller already holds — the two system-kind sites carrying the operator's display name from the orgs identity contract — never an orgs lookup inside the platform; the trailing seal requires the pair on every new event of either kind |
| 2 (P1) the membership correspondence bound `entityId`, `transitionId` and `activeCount` while `decisions.effects` decides a crossing from the UNBOUND payload `role` and `to`, so a hand-run bundle citing the real fact could write `role: 'engineer'` or a non-active `to`, commit, be recorded `noop`, and the new architect never re-notified; and the check ran one way, so a standalone catalog-valid crossing event with no fact could fabricate a re-notification | §A.2 the standing paragraph and its hostile enumeration; §A.3 obligation 7 (the converse) and the correspondence table; §D 4d-i; P29b, P31, P37 | the event's `role`, `membershipId`, `from`, `to`, `transitionId` and `activeCount` and the envelope's actor pair ALL equal the immutable fact; and obligation 7 gains its CONVERSE for every sealed event type — an event of a sealed type commits only with exactly one same-transaction transition of the fact the table names, judged by the event-owning module's DEFERRED trigger on the kernel table filtered to its own types and reading only its own tables (the delivered `phase6_t4b2_membership_guard` shape) |
| 3 (P1) the round-1 sweep listed the suites that disable the approval guard by hand and missed the cleanups that delete with NO bypass at all — `phase6-t4b-decider.test.ts` at three per-test discards, two child-clearing deletes in `phase6-t4a-withdraw.test.ts`, a raw `DELETE` in `decision-option-kinds.test.ts` — which the unconditional seal aborts, and the tripwire grepped only for `DISABLE TRIGGER` so it could not see them | §A.3 obligation 7 (the audit register); §D 4d-i; P31 | EVERY `DecisionEvent` UPDATE and DELETE site in `test/` and `scripts/` is enumerated by category — routed through `wipeDecisionEvents`, admitted as a whole-table reset bypass, or asserted as a hostile refusal — the three precision arms that expect a BENIGN mutation to succeed are rewritten to assert the append-only refusal by message, and the tripwire enumerates the STATEMENTS (Prisma and raw) rather than the bypasses, admitting exactly those three shapes |
| 4 (P1) `Notification.eventId` was an FK to `DomainEvent(eventId)` alone, so a direct writer could bind project A's feed row and visible decision to project B's event, copy its `eventType` into `kind`, and have A's renderer serve B's content — the FK, the trailing seal and the binding freeze all accepting it | §A.3 obligation 7 (the feed row); the lineage's third answer; §D 4d-i; P31 | `DomainEvent` gains a `(projectId, eventId)` candidate key and `Notification(projectId, eventId)` is a SAME-PROJECT composite FK to it, exactly as every other 4d reference is bound; the binding freeze already holds `projectId`, so a cross-project binding is unrepresentable at insert and cannot be reached by update |

**Review round 1 on #556 (head `bb307c74`) — three findings, all P1,
folded on its ONE correction head.** Two are alternate-writer and
serialization instances the narrowed rule had not enumerated; one is the
review protocol's own seam rule applied to this plan's staging:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `prisma/ensure-accounts.ts` (the manual `ensure-accounts` command and the `AUTO_ENSURE_ACCOUNTS=true` boot path) creates a `User` from an `ACCOUNTS_JSON` entry and then upserts its `Membership` directly; an entry with `role: "architect"` would pass the User write and be refused at the membership by the permanent provenance seal, failing provisioning with the user left behind | §A.2 the alternate-writer enumeration; §D 4d-ii; P28b | EVERY `Membership` writer outside `members.service` is enumerated — the sign-in provisioning (`engineer` only), project creation (`pmc` only), the demo seed, and `ensure-accounts` — and `ensure-accounts` VALIDATES the whole `ACCOUNTS_JSON` before its first write, refusing an `architect` entry (and a `User.role` of `architect` in its backfill) with a named error and no partial write: architect standing is a product act of the PMC through the ledgered commands, never a provisioning default |
| 2 (P1) "the standing cannot move between the resolution and the emission because both happen under the ONE readiness lock the standing writers take" held only for the architect path: a direct insert of an active `client` B takes no readiness key (the delivered membership guard admits additions) and can commit after a forward-to-`client` resolved holder A and before it commits, so the frozen set omits a holder at commit | §A.2 the push families; §D 4d-i; P36/P40 | the orgs-owned `Membership_t4d_readiness` BEFORE INSERT/UPDATE/DELETE trigger rides `phase6_try_readiness(projectId)` on EVERY `Membership` row write of every role — reentrant for a command that holds the key, acquire-and-hold when free, REFUSED when contended — so every standing writer serializes with every readiness-locked command and a frozen audience equals the set at commit by construction; the four writers outside `members.service` gain `lockProjectReadiness` in 4d-ii. (Corrected by #556's round 2, findings 2 and 4: the trigger is staged in 4d-iii, AFTER the drain, so no legacy two-write path ever meets it, and `OrgMembership` owner/admin writes — which DO supply the `pmc` audience — join the protocol over the org's projects.) |
| 3 (P1) 4d-i, declared the migration unit, also carried application changes (`emitEvent`, `EventActor`, the orgs identity contract, the commercial/procurement/labour/inventory call sites) that the dark, nullable columns do not need to deploy, erasing the migration/service seam | §A.3 obligation 7; §D 4d-i, 4d-ii | 4d-i is MIGRATION-ONLY in the template's sense — no service, controller, query, emitter or UI change; its `src/` diff is EXACTLY the declarative schema-metadata mirrors the boundary suite pins to the DMMF (corrected by #556's round 2, finding 5); the envelope columns land dark and nothing writes them until 4d-ii ships `emitEvent`'s write, the widened `EventActor`, the full `AttributionActor` and the identity contract together with the transitions that need them; the seals are unchanged, NULL admitted through the drain exactly as before |

**Review round 2 on #556 (head `dd2da64b`) — five findings, all P1, folded
here, none dropped.** Two are defects in round 1's own fold (a serialization
staged where a legacy writer could still meet it; an exemption that was
false for one role); one is a consumer ordering the plan had stated for two
crossings and not for three; one is a replay hazard of the persisted
catalog; one is the seam rule's own contradiction:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) if architect B activates (crossing Q) and is removed again (crossing R) before `decisions.effects` handles Q, the Q handler re-emitted unconditionally; the correspondence seal refuses an empty frozen audience, so Q fails, retries to dead-letter and, the consumer being ORDERED, blocks R and every later event of the project | §A.2 the `decisions.effects` handler; P36 | the activation handler judges the CURRENT standing under the readiness lock before re-emitting — the register's `activeCount` for `architect` — and records the crossing `noop` ("stale activation") when it is zero; the later deactivation R cancels what Q would have cancelled; a Q–R–S sequence (re-activation) yields exactly ONE fresh demand; the empty-audience refusal is a seal a handler never reaches |
| 2 (P1) round 1 staged `Membership_t4d_readiness` in 4d-i and called the drain-window refusal of a previous-release provisioning sign-in a retryable residual; it is not — the legacy `signInOrProvision` writes the `User` and the `Membership` in two statements, so a refused membership leaves a user the retry finds and then fails to sign in (`signInAccess` finds no membership), permanently, without repair | §A.2 the push families; §D 4d-ii, 4d-iii; P36 | the two standing-writer triggers are staged in 4d-iii, AFTER the attested drain — no frozen-audience family can emit before 4d-iii (the forward door refuses 409 under the reservation and a countersign needs an architect the reservation forbids), so the serialization is needed exactly from 4d-iii, when every writer is the new release's and holds the key; 4d-ii also makes the sign-in provisioning ONE transaction (user + membership) under the key, so no writer can leave a half-provisioned account; there is no residual |
| 3 (P1) 4d-iii DELETED the old coverage version's catalog rows; a later mature-database `ALWAYS_EXECUTE` replay of 4d-i re-seeded them, and between that replay and 4d-iii's a hand-run event with the retired intent passed `DomainEvent_t4d_envelope` and survived the second deletion | §A.3 obligation 7 (the persisted catalog); §D 4d-i, 4d-ii, 4d-iii; P37/P38 | retirement is a durable TOMBSTONE, never a delete: `ExternalEffectCatalog.retiredAt` (nullable; the ONE admitted UPDATE is its gated NULL → timestamp stamp, frozen after) — the envelope seal refuses an intent whose row is retired; every catalog seed is `INSERT … ON CONFLICT DO NOTHING`, so a replay never resurrects a retired row; the bootstrap's `coverageVersion` equality is against the newest UNRETIRED version |
| 4 (P1) the exemption "`OrgMembership` never changes a project role's audience" is false for `pmc`: the delivered `effectiveRoleHolderUserIds` includes membership-less org owners/admins, so an `OrgMembership` insert or promotion without the key could add owner B after a forward to the `pmc` role froze owner A | §A.2 the push families; §D 4d-ii, 4d-iii; P36 | the orgs-owned `OrgMembership_t4d_readiness` trigger (4d-iii) tries the readiness key of EVERY project of the org, in ascending project id, on any write whose OLD or NEW role is `owner`/`admin` — the set the delivered `guardedOrgStandingWrite` already locks — refusing when any is contended; the org writers take `lockProjectReadiness` over the same set in the same order in 4d-ii; `platform_role_holder_user_ids(project, 'pmc')` carries the org-owner arm so seal and service resolve one set |
| 5 (P1) "no `src/` file" contradicted the registration of the new tables in `decisionsManifest.ownsModels`/`readEncapsulated`, which live under `src/` and which the boundary suite requires to equal the DMMF exactly | §D 4d-i (the unit's scope rule) | 4d-i's `src/` diff is EXACTLY the declarative schema-metadata mirrors the tripwire suites pin to the Prisma DMMF — the three manifests' `ownsModels`/`readEncapsulated` registrations and the `MODEL_OWNER` map — enumerated file by file in its packet, no service, controller, query, emitter or UI change; the unit declares `migration-scope: inseparable` with exactly that boundary stated, and the packet's file list is the reviewable proof |

**Review round 1 on #557 (head `3327f761`) — five findings (three P1, two
P2), folded on its ONE correction head.** Two are the converse and the
correspondence stated one branch short (a finalizer that flips a revision
rather than inserting one; a drain-window fact with no frozen pair), one is
a phantom in the org-level serialization round 2 added, one is a catalog
ceiling the response-push widening had not reached, and one is a feed
reader that let a withdrawn decision's actionable notices stand:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the converse for `decision.approved`/`reapproved` required a same-transaction `DecisionApprovalRevision`, but a countersign and a `completed` stranded resolution FLIP the existing provisional revision's `finalized` and insert none — both legal finalizations would fail at commit | §A.3 obligation 7 (the converse) | the converse admits, tied to the exact revision the event names, EITHER a same-transaction revision (the no-chain approve) OR the same-transaction `DecisionCountersign` fact OR a `completed` `DecisionStrandedResolution` fact whose revision flipped `finalized` in this transaction |
| 2 (P2) widening `consultationRespondedPushTarget` alone left the emitter persisting `roles: ['pmc']` and the `decision.consultation_responded` catalog ceiling PMC-only, so an architect requester's send would carry an intent that records a PMC audience, or an honest emitter would abort at `buildDispatchIntent` | §A.2 the consultation carve-out; §D 4d-ii; P38 | the event joins 4d-ii's catalog widening (ceiling `['pmc', 'architect']`) and the emitter persists the requester's ACTUAL role read from the consultation row, so the immutable intent records the audience the send reaches |
| 3 (P1) project creation racing an owner/admin insertion for the same org: the org writer enumerated projects before the uncommitted `Project` was visible and took no key for it, so a later forward on that project could freeze a PMC set the committing owner was omitted from — a phantom no per-project key closes | §A.2 the push families; §D 4d-ii, 4d-iii; P36 | ONE org-level readiness key `org:<orgId>` (the same advisory shape, `lockOrgStanding`/`phase6_try_org_readiness`): project creation holds it while it inserts, every owner/admin `OrgMembership` writer takes it FIRST and then the project keys ascending (the trigger tries all of them), so a project cannot appear during an org write and an org write cannot enumerate a stale set; the lock order org → project is the only order, a command never takes the org key, no deadlock; barrier-probed in both orderings with the frozen terminal audience asserted |
| 4 (P1) the audit-row correspondence bound `actorRole` to the fact's frozen role unconditionally, but a previous-release no-chain approval through the drain writes the audit row's `actorRole` and leaves the revision's `approvedByRole` NULL — every legacy approval would abort at commit; the NULL exception covered the envelope only | §A.3 obligation 7 (attribution); §D 4d-iii; P42 | the audit row's and the envelope's `actorRole`/`actorName` bind to the fact's frozen pair WHERE the fact carries one; a fact whose pair is NULL — representable only through the drain, before 4d-iii's trailing seal — binds `actorId` alone on both, the drain-compatible branch stated once for every fact with a frozen pair |
| 5 (P2) narrowing the withdraw's notice retirement to `kind IS NULL` left a withdrawn decision's kinded `decision.published`/`decision.forwarded` notices in the feed, and the visibility filter does not hide them from a PMC, who may view withdrawn decisions and would read "awaiting approval" beside the withdrawal | §A.3 obligation 7 (the readers); §D 4d-ii; P31 | the kinded feed readers SUPPRESS the ACTIONABLE kinds (`decision.published`, `decision.forwarded`, `decision.awaiting_countersign`, `decision.change_requested`) of a decision whose status is `withdrawn` — a named set under the renderer tripwire — while the informational kinds and the withdrawal notice render; the rows and their events stay as evidence, never deleted (the binding seal forbids it) |

**Review round 2 on #557 (head `6d5545ce`) — four findings (two P1, two
P2), folded here, none dropped.** Each is a second-order consequence of a
round-1 fold: the org-level key had a service-only door, the org lock left an
authority read outside it, the "exact revision" binding had no durable key,
and the "requester's role at request time" had no column to be read from:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) round 1 serialized project creation on the org key in the SERVICE only; a direct `Project` INSERT took no key and reproduced the phantom (an owner write enumerating projects before the uncommitted project is visible) | §A.2 the push families; §D 4d-iii; P36 | the orgs-owned `Project_t4d_org_readiness` BEFORE INSERT trigger (4d-iii, beside the two standing-writer seals) tries `phase6_try_org_readiness(NEW."orgId")` on EVERY `Project` insert, so a direct insert holds the org key or is refused exactly as the service's creation does — the database-side door the claimed serialization needed |
| 2 (P2) "tied to the exact revision the event names" had no durable key: the delivered `decision.approved` payload carries option, material and `onBehalfOf` only, so with several revisions an older kinded green notice could render the newest head's approver, and the converse's advertised binding had nothing to bind on | §A.3 obligation 7 (the correspondence table and the converse); §D 4d-ii; P31 | every 4d-ii emitter of `decision.approved`/`reapproved` — the direct approve, the countersign, the `completed` resolution — carries the EXACT finalized `revisionId` in the payload; the correspondence binds it to the fact and the converse resolves the finalizer through it; a previous-release event through the drain (no `revisionId`) falls back to the same-transaction revision insert for the decision, the only finalizer a pre-4d-ii process can produce; a kinded green notice renders the approver facts from the revision its event names, never the head |
| 3 (P1) `OrgsService.createProject` reads the caller's org role BEFORE its transaction; an admin could pass that read, be demoted under the org key, then acquire the key and create the project | §A.2 the push families; §D 4d-ii; P36 | 4d-ii RE-JUDGES owner/admin standing AFTER `lockOrgStanding` is held, inside the transaction and before the `Project` insert (the pre-transaction read stays as the fast refusal); a demotion that commits under the org key first refuses the creation 403 at the re-judge, both orderings barrier-probed |
| 4 (P2) the `respond` emitter was to persist "the requester's standing at the time of the request", but `DecisionConsultation` records `requestedById` only and no unit added a role column, so the role could only be resolved at response time — not equivalent for a requester who changed roles or holds both | §A.2 the consultation carve-out; §A.3 the fact table; §D 4d-i, 4d-ii; P38 | 4d-i adds the nullable `DecisionConsultation.requestedByRole` (frozen with the row by the delivered consultation seals; NULL only on legacy rows, which only a `pmc` could request); 4d-ii's `consultation.request` writes the role the INSERT seal judged (`pmc` or `architect`) and the seal's requester arm judges it as it judges every frozen role; the `respond` emitter reads that frozen column and binds the response intent to it |

**Review round 1 on #558 (head `a07f78b7`) — seven findings, all P1,
folded on its ONE correction head.** Five are the narrowed rule stopped one
instance short (a converse branch without its crossing, a converse without
its other half, a same-project key that was not a same-decision key, a
reader whose two reads were two snapshots, an obligation deferred to a
background pass), one is a lock that did not cover the second audited
table, and one is a review finding against a recorded BOARD decision, which
this plan answers by adding what the runner can verify and raising the
decision where it belongs:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the converse's `renotified` branch accepted a `decision.awaiting_countersign` with only a same-transaction `countersign_renotified` audit row — no binding to a real crossing, no uniqueness per (decision, crossing), no push-shape check — so a direct writer could commit a standalone demand the relay sends | §A.2 the `decisions.effects` re-emit; §A.3 obligation 7 (the converse); §D 4d-i; P36 | the branch requires the payload to name `crossingEventId` and `transitionId`, verifies through the new kernel read `platform_event(projectId, eventId)` that the crossing is a committed `membership.standing_changed` event of the project naming that fact at an EARLIER position, requires the audit row to name both, is UNIQUE per (decision, crossing) by a decisions-owned partial unique index, and applies the SAME push-shape check the provisional approve's seal applies — constant body, `targetUserIds` equal to the active architects at commit |
| 2 (P1) the `decision.change_withdrawn` converse required the request closed to `withdrawn` but not the decision restored `change → approved`, so a direct transaction could close the sole open request, leave the decision in `change`, and strand it (no open request to withdraw, no state to approve from) | §A.3 obligation 7 (the converse, both halves); P37 | the closure and the restoration are sealed as ONE bundle in both directions: a decisions-owned deferred trigger on `ChangeRequest` requires, for a `standard` request written to `withdrawn`, the same-transaction `Decision` row landed `approved` and the `decision.change_withdrawn` event; the approved-entry seal's restoration arm already requires the same-transaction closure; neither half commits alone |
| 3 (P1) the `(projectId, eventId)` key proved the feed row and the event share a project, not that the event is ABOUT the row's decision — a notice for decision A could bind B's event and render B's content under A's visibility | §A.3 obligation 7 (the feed row); §D 4d-i; P31 | the same-decision binding is required on INSERT — carried, since #572's round 4, by the separately named DEFERRED `Notification_t4d_binding_bound` rather than by the immediate freeze trigger, which cannot also be a constraint trigger: a kinded row carrying `decisionId` binds only an event whose `entityType = 'Decision'` and `entityId = decisionId` — identity columns compared, no decision semantics in the platform |
| 4 (P1) the drain gate admits only an `OPERATOR-ATTESTATION` and forbids an agent-generated one; in an autonomous loop with no human standing by the task would stay `in_progress` and 4d-iii never run | §D the drain attestation, 4d-ii, 4d-iii | the plan ADDS the trusted autonomous evidence the runner can verify fail-closed — the `ReleaseLease` register every serving process writes at startup and renews with its compiled consumer-catalog version (in-database evidence for every drain from 4d-ii on) and, for the processes that predate the register, the deploy platform's running-container inventory read by `rollout:drain-evidence` — as CORROBORATION; the operator attestation stays REQUIRED: the question was raised on #482 and answered there (comment 5569586836: the user's standing instructions retain human production attestation, evidence does not replace it, and no review request or agent statement can remove it), so the gate is attestation-with-corroboration, fail-closed, and its removal is the user's separate decision alone |
| 5 (P1) the audit's ACCESS EXCLUSIVE lock on `Membership` could not block a concurrent `User(role = 'architect')` creation; a still-serving `ensure-accounts` could commit its user, be refused at the membership, and leave a residual the migration's success hid | §A.1 the reservation; §D 4d-i, 4d-iii; P28b | a FIFTH door, `User_t4d_architect_reserved` (BEFORE INSERT OR UPDATE on `User`, `role = 'architect'` judged as text), installed in Part 3 under `LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE` taken beside the `Membership` lock BEFORE the audit, so the migration-first ordering refuses the user write itself and the audit's zero holds; retired by 4d-iii with the other four; every "four doors" is now five |
| 6 (P1) "the decision already loaded in the same snapshot" was two READ COMMITTED queries started independently, so a withdrawal committing between them let the notification read return a kinded withdrawal notice authorized by the stale, still-visible decision | §A.3 obligation 7 (the readers); §D 4d-ii; P29/P31 | the kinded feed path reads each notification and its governing decision's status in ONE statement (one snapshot), and judges `decisionVisibleToViewer` on the row that statement returned; the projection fold is per event and has no second read; a withdraw-between-reads barrier proves the notice absent |
| 7 (P1) a hand-run bundle's event was accepted with no same-transaction `OutboxDelivery` rows, their creation left to `expandMissingDeliveries` — which runs only when the relay runs — so with `OUTBOX_RELAY_AUTOSTART=false` or the relay down the committed transition had no durable effect | §A.3 obligation 7 (the kernel envelope); §D 4d-i, 4d-ii; P37/P38 | the platform-owned deferred `DomainEvent_t4d_deliveries` requires at commit, for every ACTIVE row of the persisted `OutboxConsumerCatalog`, exactly one same-transaction delivery row for the event whose `dispatch`/`noop` status follows a PERSISTED rule the catalog row carries (`syncConsumerCatalog` writes each consumer's `dispatchRule` — every event, `invalidate` intents, push-bearing intents, or a type set — from the compiled registry at startup); a bundle without its rows is refused, and `expandMissingDeliveries` keeps only its legacy role for events older than 4d-i |

**Review round 2 on #558 (head `64d9030f`) — nine findings, all P1,
folded here, none dropped.** Seven are second-order consequences of round
1's own folds (a crossing bound without its predicate, a closure paired for
one resolution and not the other, a persisted rule left writable, a
recovery pass narrowed by the wrong boundary, a snapshot fix that crossed a
module boundary, a reset inventory that missed two newly sealed tables, a
"five doors" fold whose §D sequence and replay contract still said four),
and two are the plan's own earlier text contradicting its later rule (the
lock order in one paragraph; the Part 3 order in another):

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the `renotified` converse verified the cited crossing's type, transition and position but not its PREDICATE, so a legitimate 1 → 2 activation the consumer classifies `noop` could be cited to commit an extra demand | §A.3 obligation 7 (the converse); P36 | the cited event must be the 0 → 1 ACTIVATION crossing — payload `activeCount = 1` and `to` an active architect — read through `platform_event`; any other standing event is refused |
| 2 (P1) narrowing `expandMissingDeliveries` to events older than 4d-i omitted the 4d-i → 4d-ii interval, during which `decisions.effects` was not yet registered; its cursor from 0 would wait forever at the first omitted position | §A.3 obligation 7 (the delivery seal); §D 4d-ii; P38 | the seal requires rows for the consumers REGISTERED at the event's commit, and expansion keeps its role for every event that predates a consumer's registration — the whole 4d-i → 4d-ii interval included — exactly the P38 registration arm |
| 3 (P1) 4d-iii's replay contract re-dropped FOUR triggers while the same paragraph retires five; a rolled-back first attempt would leave one installed and every retry aborting | §D 4d-iii | every replay re-drops all FIVE doors and their shared function `IF EXISTS`; the closing check names all five |
| 4 (P1) the one-snapshot fix joined the platform-owned `Notification` to the decisions-owned `Decision` in one SQL statement — a synchronous cross-module table read | §A.3 obligation 7 (the readers); §D 4d-ii; P31 | the snapshot opens ONE REPEATABLE READ transaction and runs the OWNER-provided queries inside it — the platform's notification query and the decisions module's decision query — judging visibility on rows from that one snapshot; no join, no foreign read |
| 5 (P1) §A.2's forwarding paragraph had approve/forward take the `Decision` lock immediately after readiness, while the canonical order locks the subject's delivery rows BEFORE the decision; a relay lease + a command could deadlock | §A.2 the forward door; P35 | the paragraph now states the canonical order — readiness → `Project` → `Membership` → the subject's delivery rows `FOR UPDATE` ascending → `Decision` — and P35's barrier probes that exact sequence |
| 6 (P1) the closure↔restoration bundle covered the `withdrawn` closure only; the reapproval path closes its request `resolved`, so a direct writer could resolve the sole open request and leave the decision in `change`, or reapprove and leave the request open | §A.3 obligation 7 (the converse, both closures); P37 | the `open → resolved` closure pairs with its reapproval transition in both directions — the same-transaction `Decision` landed `approved` (no chain) or `awaiting_countersign` (chain) with its revision, and the reapproval's entry seal requiring the same-transaction closure of the open request |
| 7 (P1) `dispatchRule`/`subscribedEventTypes` decided whether a delivery must dispatch but were written freely at startup; a direct writer could alter a rule and commit a `noop` where a push was owed | §A.3 obligation 7 (the delivery seal); §D 4d-i, 4d-ii; P38 | the rules are written ONLY by the versioned catalog-data migration under the gate, frozen by `OutboxConsumerCatalog_t4d_rules`, and `syncConsumerCatalog` VERIFIES the persisted rule equals the compiled contract at startup — refusing on drift, exactly as it treats `catalogVersion` — and never writes it |
| 8 (P1) the reset inventory covered `DecisionEvent` and memberships, but 4d-i also makes kinded `Notification` rows undeletable behind an FK to `DomainEvent` and seals `ChangeRequest`; the seed truncates `DomainEvent` without `Notification` and deletes both tables directly, as do many suites | §D 4d-i; P28b | `Notification_t4d_no_truncate` joins `TRUNCATE_SEALS` (NINE entries), the sanctioned reset truncates `DomainEvent` WITH `Notification` under the named disables, and `notification.deleteMany` / `changeRequest.deleteMany` cleanups are routed through named reset helpers (`wipeNotifications`, `wipeChangeRequests`) under the statement-enumerating tripwire, which now covers both tables |
| 9 (P1) §D's authoritative Part 3 sequence still opened with the `Membership` door alone and ran both audits before the `User` lock and door | §D 4d-i (Part 3); P28b | Part 3 opens with BOTH reservations — the `Membership` door's `CREATE TRIGGER` and `LOCK TABLE "User"` with `User_t4d_architect_reserved` — and runs the audits only after both locks are held |

**Review round 1 on #560 (head `01c6e819`) — eleven findings (nine P1, two
P2): ten folded on its ONE correction head `847b5c40`, one DECLINED on the
Board's recorded decision, none dropped.** Six are the delivery seal's own
second-order consequences (an activation boundary judged from a writable
timestamp, a reactivated consumer's stalled cursor, an unbound and
unfrozen delivery payload, a seal that would have met the standalone CLIs
with no registry, and two checklist lines that contradicted the rule they
staged), two are the plan's enumerations disagreeing with its prose (a
catalog schema without the push-shape columns; a nine-count list of
eight), one is the raw-plant bypass missing the converse, one is the 4d-ii
unit's missing large-unit packet, and one — the drain attestation — is the
question the Board has answered:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `expandMissingDeliveries` restricted to events that predate REGISTRATION would exclude event N for a consumer set inactive at N and reactivated at N + 1, so its ordered cursor waits at N forever | §A.3 obligation 7 (the delivery seal); §D 4d-ii, 4d-iii; P38 | the obligation set is the ACTIVE set at commit; expansion keeps its delivered all-missing contract for every currently-active consumer (pre-activation history, a deactivated interval on reactivation, a crash gap), each row from the SAME persisted rule |
| 2 (P1) `registeredAt` decided whether a consumer was owed a delivery but stayed a writable column; a direct writer could move it past the event and commit without the row | §A.3 obligation 7 (the delivery seal); §D 4d-ii; P38 | the boundary is an append-only, attributable `OutboxConsumerActivation` register whose AFTER INSERT trigger is the only writer of the frozen `active` mirror; `registeredAt` is frozen and plays no part in any seal; excluding a consumer requires appending a deactivation that survives as evidence |
| 3 (P1) the enumerated `ExternalEffectCatalog` schema omitted `requiresPush` and `pushBody`, which the transition seal reads | §A.3 obligation 7 (the intent); §D 4d-i | both columns join the schema, the seed, the tripwire and the frozen set |
| 4 (P1) the delivery seal judged only `dispatch`/`noop`; a sealed event naming the full architect set could carry a delivery inserted or rewritten to one chosen architect or a foreign body | §A.2 the push families; §A.3 obligation 7; §D 4d-ii; P37 | a `dispatch` row's `payload`/`subject` are the platform's PROJECTION of the immutable intent, bound at insert by `OutboxDelivery_t4d_bound` and frozen by `OutboxDelivery_t4d_frozen`; only lease/status columns and the 4a cancellation mark stay mutable |
| 5 (P1) "remove the mandatory human drain attestation" | §D the drain attestation | DECLINED — a Board decision, not a plan defect: raised on #482 and answered there (comment 5569586836: the user's standing instructions retain human production attestation; the autonomous evidence is corroboration; no review finding or agent statement can remove it). The plan carries the gate exactly as decided; its removal is the user's separate decision |
| 6 (P1) the seal staged in 4d-i would have refused the standalone CLIs (`commercial-reevaluate.cli.ts`, `capability.cli.ts`), whose process-local registry is empty so `materializeDeliveries` writes no rows | §A.3 obligation 7; §D 4d-i → 4d-ii; P37 | the row set is a pure function of the event and the PERSISTED catalog (`deliveryRowsFor`, called by materialization and expansion alike; `deliveryFor` retired), so a process with no registry writes the same rows; the seal, the rule columns, the register and the rewrite ship together in 4d-ii, and `decisions.effects` stays inactive until 4d-iii so a drained-through pre-4d-ii process is never refused |
| 7 (P1) the 4d-ii checklist had `syncConsumerCatalog` WRITING the rules the same plan declares migration-written and frozen | §D 4d-ii | the checklist says VERIFYING, refusing on drift, never writing |
| 8 (P1) the 4d-ii checklist had the feed read "joining each notice to its decision's status in one statement" — the cross-module join §A.3 refuses | §D 4d-ii | the checklist says the two owner-provided queries inside one REPEATABLE READ transaction, no join |
| 9 (P1) 4d-ii exceeds the standard unit but the plan required neither `justified-large` nor the six-row matrix of it | §D 4d-ii | 4d-ii MUST carry the large-unit packet; both seams are argued (the catalog version with its code; the client boundary with its server) and stated as inseparable, not assumed |
| 10 (P2) `TRUNCATE_SEALS` "gains NINE entries" but the list named eight | §D 4d-i | `Notification_t4d_no_truncate` is named; nine listed, nine counted |
| 11 (P2) the legacy-plant bypass named two triggers while 4d-i also installs the converse; `outbox.test.ts`'s standalone `decision.approved` plants would fail at commit before their outbox assertion | §D 4d-i (the sweep); P37 | the named bypass disables the FULL set (envelope, allocation, converse; from 4d-ii the delivery seal); the outbox probes move to an unpaired announcement family (`decision.published`); a probe needing an approval event builds its bundle through the service |

**Review round 2 on #560 (head `847b5c40`) — six findings (five P1, one P2),
carried here, none dropped.** Four are second-order consequences of round
1's own folds (the activation register left truncatable and its reason
blank; the lease register's identity left writable; the converse checking
the crossing's kind but not its order against the demand), one is the
trailing-seal inventory a round-1 fold on #557 owed (the `ChangeRequest`
pair), and one is the standing register's own replay contradiction:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) 4d-iii's trailing INSERT-time seals required `sourceCommandId` on every new `ChangeRequest` row but not the frozen `requestedByRole`/`requestedByName` pair 4d-i adds, so after the drain a hand-run standard request could leave both NULL and take the actor-id-only correspondence branch the plan says closes there | §D 4d-iii; §A.3 obligation 5; P42 | the pair joins the 4d-iii requirement on every new `ChangeRequest` row whatever its origin; the NULL branch closes for requests exactly as for revisions and events |
| 2 (P1) the activation register refused UPDATE and DELETE but not TRUNCATE, and the reset inventory deliberately omitted it; a direct `TRUNCATE` could erase the evidence and leave the `active` mirror unexplained | §A.3 obligation 7 (the delivery seal); §D 4d-ii; P38 | the statement-level `OutboxConsumerActivation_t4d_no_truncate`, registered in `TRUNCATE_SEALS` (which now gains ELEVEN entries) while the table stays outside every sanctioned reset |
| 3 (P1) the converse verified the cited crossing's kind and order against the RE-EMIT but not against the DEMAND: a decision approved after an otherwise-unused activation Q could cite Q and commit a second demand the ordered handler would have skipped | §A.3 obligation 7 (the converse); P36 | the converse also requires the decision's LATEST `decision.awaiting_countersign` to sit at or before the cited crossing, read through the kernel's committed-row `platform_latest_event` — the handler's decisive predicate, mirrored |
| 4 (P2) `OutboxConsumerActivation.reason` was not required non-null or non-blank | §D 4d-ii; P38 | `reason` carries the `DecisionForward.reason` discipline: zod trims and requires length ≥ 1; the CHECK rejects a value empty after every ASCII whitespace character is stripped |
| 5 (P1) the standing register's writer-depth seal admitted only nested writes, yet 4d-i backfills directly and declares the backfill re-runnable; an `ALWAYS_EXECUTE` replay over a project created since would have its zero-row insert refused by the seal already installed | §A.2 the kernel read; §D 4d-i; P29b | the backfill is an EXPLICIT gated writer arm — `INSERT … ON CONFLICT DO NOTHING` under `SET LOCAL vitan.phase6_4d_standing_backfill = 'on'`, admitted at depth 1 only under the gate and only as a zero-count insert for a project without a row; refused outside it |
| 6 (P1) `ReleaseLease` carried no writer seal or deletion protection, so a live lower-version lease could be re-versioned to the minimum or deleted before 4d-iii's preflight, which would then retire the doors while the old process served | §D the drain attestation, 4d-i, 4d-iii; P42 | the row's identity is FROZEN after insert (`ReleaseLease_t4d_frozen` admits only a non-decreasing `leaseUntil`), DELETE refused, `ReleaseLease_t4d_no_truncate` in `TRUNCATE_SEALS`; a stopped process's lease expires and stays as history |

**Review round 1 on #561 (head `b2e556c3`) — seven findings (six P1, one
P2), folded on its ONE correction head `d5646595`, none dropped.** One is the plan's
own boundary rule applied to its own seals (a decisions trigger calling an
orgs-owned function is still a read of a peer's table), one is an
authorization boundary left to the implementation, two are the seventh
obligation applied to the two delivered consultation facts and to the
counter row every allocation trusts, two are second-order consequences of
#560's folds (the cancellation mark and the activation sequence), and one
is a reader the enumeration missed:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) every 4d decisions fact seal called `platform_user_holds_role`, an orgs-owned function reading `Membership`/`OrgMembership` — a synchronous foreign read from the leaf decisions module (`dependsOn: []`, with `orgs.dependsOn` naming `decisions`) that wrapping in a function does not remove | §A.2 the kernel read; §A.3 obligation 3; §D 4d-i; P28b/P29b | per-user standing and identity are projected by their owner into platform-owned registers (`ProjectUserStanding`, `UserIdentity`) exactly as the role count is, written only by generic platform primitives the orgs triggers call, backfilled in 4d-i, verified offline; the seals read them through `platform_user_holds_role`/`platform_user_orchestration_authority`/`platform_user_display_name`, and no decisions seal invokes an orgs-owned function |
| 2 (P1) the architect's `ROLE_POLICY` set was "every entry the role belongs in", named only in part, with the route walk pinning whatever the implementation chose | §A.1; P28 | the EXACT twelve-action set is stated (eleven since #572's review round 3 removed `decision.change`; three reads, five delivered decision actions, `consultation.request`, `decision.forward`/`countersign`/`disagree`), the exclusions named, and P28 asserts equality over every `ROLE_POLICY` action |
| 3 (P1) the §A.3 table left `DecisionConsultation` and its response with service-emitted, unsealed effects, so a hand-run consultation committed without its event | §A.3 obligation 7 (the converse); §D 4d-i; P37 | both facts require their same-transaction event naming the consultation and the converse refuses the event without its fact, sealed in 4d-i (the delivered service already emits both in-transaction) |
| 4 (P1) `cancelledAt` was left freely mutable, so a direct writer could suppress a leased push or un-cancel a stale one | §A.3 obligation 7 (the delivery seal); P37 | `OutboxDelivery_t4d_frozen` admits `cancelledAt` only as the NULL → timestamp write of the mark's own statement or the delivered leased/dead mark-only arm, never cleared or rewritten |
| 5 (P1) the activation register's per-consumer sequence had no lock-before-append protocol; two appends could commit seq 2 then seq 1 and leave the mirror at the older fact | §A.3 obligation 7 (the delivery seal); P38 | the BEFORE INSERT takes the catalog row `FOR UPDATE` and requires `seq = activationSeq + 1`; the AFTER INSERT advances `active` and `activationSeq` together; the loser is refused with a stale sequence |
| 6 (P2) `SnapshotService.shellSummary` counts `status === 'pending'` itself and never calls `countPending`, so the nav badge would read zero for an architect's awaiting obligation P31 asserts | §A.1 the readers; P31 | the shell badge is served by the SAME `countPending`; P31 asserts the badge for the architect's awaiting decision and the PMC's stranded one |
| 7 (P1) a `ProjectEventStream` row could be deleted and reinserted at `N + 2`, bypassing the `+1` seal and leaving position N absent forever | §A.3 obligation 7 (the kernel envelope); §D 4d-i; P37 | DELETE refused outside the project-deletion cascade — and "cascade" is the RI trigger DEPTH (`pg_trigger_depth() > 1`) AND the transaction-local project-deletion flag, both, exactly as the `MembershipTransition` exception already demands (#582's review rounds 6 and 8: the flag alone stands `on` for the rest of a transaction that deleted ANY project, so a direct depth-1 delete of a SECOND project's allocator rode it and left that project unable to emit) — INSERT admitted only at `nextPosition = 0` for a project without events, `ProjectEventStream_t4d_no_truncate` in `TRUNCATE_SEALS` (now FOURTEEN) |

**Review round 2 on #561 (head `d5646595`) — nine findings, all P1, carried
here, none dropped.** Six are second-order consequences of round 1's own
folds (the per-user register's inherited-`pmc` recompute, its identity
projection on insert, and two audience arms that still named orgs
primitives; the activation register's lock against the event path; the
4d-iii activation's fixed sequence), two are seal reads that lacked a lock
order or a required-push arm (the retirement stamp; the push every effect
owes), and one is the reset inventory missing the three new fact tables:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the membership trigger wrote the user's old and new role rows but never recomputed the conditional membership-less `pmc` row, so an org owner gaining an active `engineer` membership kept `pmc` and one losing their last membership never regained it | §A.2 the kernel read; P28b/P29b | `Membership_t4d_role_standing` recomputes the `pmc` fallback for that user on that project whenever their active-membership presence changes; both transitions probed |
| 2 (P1) the envelope seal demanded a push only of the two frozen-audience families, so a hand-run no-chain approval could seal a `noop` push row where the delivered service always announces | §A.3 obligation 7 (the intent); §D 4d-i; P37 | the catalog carries `requiresPush` and an `audience` (`broadcast` — `roles` EQUAL the ceiling; `targeted` — a target present within the ceiling, the delivered 4b narrowing; `frozen` — the existing rule) for every pushing family, seeded with no default; the seal requires the push wherever it is owed |
| 3 (P1) 4d-iii's fixed `(consumer, seq)` `ON CONFLICT DO NOTHING` activation could be skipped by an operator activation-then-deactivation that consumed the sequence, retiring the doors with `decisions.effects` inactive | §D 4d-iii; P42 | 4d-iii locks the catalog row, appends the activation at `activationSeq + 1` only if the head is not active, and VERIFIES the head active in the same transaction, aborting the retirement otherwise |
| 4 (P1) the correspondence check's audience arm still called the orgs-owned `phase6_role_holder_user_ids`, and the named-holder arms the orgs-owned `phase6_membership_active_user` — the cycle round 1 closed, reopened | §A.2 the kernel read and the forward door; §A.3 obligation 7; §D 4d-i | `ProjectUserStanding` carries the granting `membershipId`; the kernel serves `platform_role_holder_user_ids` and `platform_membership_active_user` over it; every NEW seal uses those; the delivered 4b/4c primitives stay for the delivered seals only |
| 5 (P1) the event path read `OutboxConsumerCatalog.active` without the lock the activation append takes, so an activation could commit between the event's check and its commit, leaving an event with no row for a consumer active at its commit | §A.3 obligation 7 (the delivery seal); P38 | `deliveryRowsFor` reads the catalog rows `FOR SHARE` and the event transaction holds them to commit; the append's `FOR UPDATE` orders before or after the whole event; both orderings under the barrier |
| 6 (P1) the envelope seal read `retiredAt` without a lock against the gated retirement stamp, so an event could commit on an intent retired between its check and its commit | §A.3 obligation 7 (the intent); P37 | the seal locks the referenced catalog row `FOR SHARE` before reading `retiredAt`; the stamp's `FOR UPDATE` orders deterministically; both orderings under the barrier |
| 7 (P1) `User_t4d_identity` handled only a rename, so an account provisioned after 4d-i had no identity row and every fact of theirs would be refused | §A.2 the kernel read; P29b | the trigger fires on INSERT too, projecting a new account the instant it exists; a newly provisioned actor is probed |
| 8 (P1) the consultation facts froze only the requester's role: no requester name, no responder role or name, so a hand-run request or response could pair the real actor id with an arbitrary envelope attribution | §A.2 the consultation surface; §A.3 obligations 1 and 3; §D 4d-i, 4d-ii, 4d-iii; P37 | both facts carry the frozen role + name pair (nullable through the drain, required by 4d-iii), judged against the platform registers and bound to their event envelopes exactly as every 4d fact's pair is |
| 9 (P1) the reset inventory omitted `DecisionForward`, `DecisionCountersign` and `DecisionStrandedResolution`, so a scenario that created one could never tear down its `Decision` | §D 4d-i (the reset protocol) | the three tables join the sanctioned seed and fixture reset child-first under their row seals disabled by name for that reset only |

**Review round 1 on #562 (head `be56b941`) — six findings (five P1, one
P2): five folded on its ONE correction head `2f493f8f`, one DECLINED on the
Board's recorded decision, none dropped.** Three are the plan's own boundary rule
applied one level further (a chain check, a management-authority check and
a notification FK order the earlier text had left to the delivered orgs
primitive or the delivered writer order), two are second-order
consequences of #561's folds (the consultation converse binding the event
but not its target; the latest-demand lookup seeing its own event), and one
— the drain attestation — is the question the Board answered:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) one sentence still sent the approve CAS and every DB seal to the orgs-owned `phase6_effective_role_standing` for the chain check — the decisions → orgs read the register exists to remove | §A.2 the kernel read; P37 | the approve CAS reads `RoleStandingQuery.activeCount` and every NEW seal the kernel's `platform_role_standing` over `ProjectRoleStanding`; the delivered primitive stays for the delivered `client`/`pmc` seals only |
| 2 (P1) `MembershipTransition.actorRole` was required to be `pmc`, but an org owner/admin holding an active non-PMC membership carries that membership's role in their token and in the register while `MembersService.canManage` rightly admits them — a valid add, removal or re-role would fail its own seal | §A.2 the ledgered transition; §A.3 obligation 3; P29b | the frozen `actorRole` is the actor's ACTUAL token role, judged as every frozen role is; team-management AUTHORITY is judged separately by `platform_user_manages_team` over a `pmc` row or the platform-owned `OrgUserAuthority` register the `OrgMembership` trigger projects |
| 3 (P1) "remove the human-only drain gate" | §D the drain attestation | DECLINED — a Board decision, not a plan defect: raised on #482 and answered there (comment 5569586836: the user's standing instructions retain human production attestation; the autonomous evidence is corroboration; no review finding or agent statement can remove it). The plan carries the gate exactly as decided; its removal is the user's separate decision |
| 4 (P1) the `Notification(projectId, eventId)` FK was not deferrable while the delivered writers create the notice before `emitEvent` allocates the event | §A.3 obligation 7 (the readers); §D 4d-i, 4d-ii | the FK is `DEFERRABLE INITIALLY DEFERRED`; 4d-ii stamps the existing inserts with the id `emitEvent` will use; the FK and the binding trigger both judge at commit |
| 5 (P2) the consultation converse bound the event to the consultation but not its dispatch target to the fact, so a request targeting another user or a response targeting a stranger passed the seal and was cancelled at claim | §A.3 obligation 7 (the converse); P37 | the request's intent must target the frozen `consulteeUserId`, the response's the fact's `requestedById` with `roles` bound to the frozen requester role |
| 6 (P1) the latest-demand lookup ran inside the inserting transaction and could select the re-emitted demand itself, refusing every valid re-emission | §A.3 obligation 7 (the converse); P36 | `platform_latest_event` takes `before := NEW."streamPosition"` and returns the latest demand strictly before the event being judged |

**Review round 2 on #562 (head `2f493f8f`) — five findings, all P1, carried
here, none dropped.** Three are second-order consequences of round 1's own
folds (the authority register introduced without its writer; the forward
door's role check sent to a register that carries one role; the 4d-i
inventory naming one of the four consultation columns), one is a
drain-window interleaving the org-key doors do not reach until 4d-iii, and
one is the delivered relay's own transitions the frozen-delivery seal
would have refused:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `OrgUserAuthority` was introduced with no primitive, trigger or backfill populating it, so `platform_user_manages_team` failed every owner/admin who also holds a non-PMC membership | §A.2 the kernel read; §D 4d-i; P29b | the generic `platform_org_authority_apply(orgId, userId, role, present)` primitive, the orgs-owned `OrgMembership_t4d_org_authority` trigger (insert, promotion, demotion, removal), the 4d-i backfill under the gated arm, `platform:verify` and P29b arms |
| 2 (P1) the forward door judged a role `toDesignation` by `platform_role_standing`, but `ProjectRoleStanding` carries the `architect` row only, so a forward to a live `client` or `pmc` role was refused at the DB | §A.2 the forward door; P30/P34 | the role target is judged by `platform_role_has_holder(project, role)`, an EXISTS over the per-user register, which is populated for every role |
| 3 (P1) between 4d-i and 4d-iii a `Project` INSERT and an owner/admin `OrgMembership` INSERT could each run its AFTER trigger before the other's row was visible, leaving no `pmc` row for a valid holder, and installing the doors later repairs nothing | §A.2 the kernel read; §D 4d-iii; P29b/P42 | 4d-iii RE-PROJECTS `ProjectUserStanding` and `OrgUserAuthority` from the orgs truth under the org key, org by org, in the same transaction BEFORE installing the doors or dropping a reservation; the interleaving is barrier-tested and the repair asserted (the "under the org key" of this answer is superseded by #563's round 2: the repair is taken behind the table fence) |
| 4 (P1) the authoritative 4d-i inventory named `DecisionConsultation.requestedByRole` alone while §A requires 4d-ii to write four columns and 4d-iii to seal them | §D 4d-i | all four nullable frozen columns and their DMMF-pinned metadata are in the 4d-i inventory |
| 5 (P1) the frozen-delivery seal admitted `dispatch → noop` only with `cancelledAt` set in the same statement, refusing the relay's leased-cancel completion and its neutralization of a pending pre-intent event | §A.3 obligation 7 (the delivery seal); P37 | the seal admits exactly the THREE relay-owned transitions the delivered code performs: the same-statement mark, the completion of an already-marked row, and the retirement of a pending row whose event has no intent |

**Review round 1 on #563 (head `6bf75a36`) — five findings (four P1, one
P2): four folded on its ONE correction head `01706fe`, one DECLINED on the
Board's recorded decision, none dropped.** Two are second-order consequences of
earlier folds (the deferred notice FK without the id its writers must
mint; the delivery seal's "never forbids a row" leaving an inactive
consumer's planted row unjudged), two are checklist lines that lagged the
design (`deliveryFor` named after its retirement; a probe naming a service
file that does not exist), and one — the drain attestation — is the
question the Board answered:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) "replace the human-only drain gate" | §D the drain attestation | DECLINED — a Board decision, not a plan defect: raised on #482 and answered there (comment 5569586836: the user's standing instructions retain human production attestation; the autonomous evidence is corroboration; no review finding or agent statement can remove it). The plan carries the gate exactly as decided; its removal is the user's separate decision |
| 2 (P1) the deferred FK let writers stamp "the id `emitEvent` will use", but `EmitInput` has no `eventId` and the kernel lets PostgreSQL default it, so the writers could not know the id | §A.3 obligation 7 (the readers); §D 4d-ii | `EmitInput.eventId` is optional and caller-minted; `emitEvent` passes it into `domainEvent.create`; every notification writer mints the id, stamps the notice, then emits |
| 3 (P1) the delivery seal never forbade a row, so a row planted for an INACTIVE consumer with the wrong action survived reactivation and misdirected the ordered cursor | §A.3 obligation 7 (the delivery seal); P37 | existence is required only for the active set, but `OutboxDelivery_t4d_bound` judges EVERY row's `deliveryAction` against its consumer's persisted rule, whatever the activation state |
| 4 (P2) P41 named `consultations.service.ts`, which does not exist | §B P41 | P41 names `decisions.service.ts` `requestConsultation`/`respondToConsultation`, the delivered 4c commands |
| 5 (P1) the 4d-ii checklist still said the consumer's `deliveryFor` copies `targetUserIds`, the process-local path the plan retired | §D 4d-ii | the checklist names the platform's `deliveryRowsFor` projection |

**Review round 2 on #563 (head `01706fe`) — one finding (P1), carried
here, none dropped.** It is a second-order consequence of #562's round-2
fold: the re-projection that closes the drain window was itself
serialized by the org key alone, which a direct SQL writer never takes:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) 4d-iii's re-projection ran before the doors were installed and held only `lockOrgStanding`, so a direct `Project` INSERT and a direct owner/admin `OrgMembership` INSERT could both commit AFTER the repair's snapshot and BEFORE the doors were installed, and the migration then committed without the `pmc` row a valid owner is owed | §A.2 the kernel read; §D 4d-iii; P42 | 4d-iii FENCES every writer of the three orgs tables FIRST — `LOCK TABLE "Project", "OrgMembership", "Membership" IN SHARE ROW EXCLUSIVE MODE`, taken before the snapshot and before any door, in that one order, held to commit — so every write that began before the fence has ended and is visible to the snapshot, no write can commit between the snapshot and the doors, and the first write after commit meets the installed doors; the migration takes NO org key (the fence subsumes it, and a key taken after the fence could deadlock against a writer holding the key and waiting on the fence); P42's arm starts a direct-SQL pair after the fence and observes it BLOCKED, the repair and the doors committing, the pair then meeting the doors (the post-fence contention — one commits, the other is refused and retried — is modelled by #564's round 2) |

**Review round 1 on #564 (head `93349e6`) — one finding (P1), DECLINED on
the Board's recorded decision, nothing folded.** It is the drain attestation
again, the only finding on the head, and the first head of this lineage on
which the Board-decided gate is the ONLY thing the reviewer raises:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) "allow the runner to clear the drain gate autonomously" — the fail-closed evidence should be sufficient without human sign-off | §D the drain attestation | DECLINED — a Board decision, not a plan defect (#482 comment 5569586836: human production attestation is retained; the autonomous evidence is corroboration; no review finding or agent statement removes it). The plan carries the gate exactly as decided; the contradiction between `AGENTS.md` L72–75 ("do not block on human sign-off") and the recorded decision — the reason the reviewer raises it on fresh heads — is escalated to the Board on #482 as a concrete convergence blocker, and its resolution either way is the user's separate decision |

**Review round 2 on #564 (head `2a47037`) — three findings, all P1,
carried here, none dropped.** One is a second-order consequence of #563's
round-2 fold (the post-fence pair meets the doors, which try one key and
refuse the loser), one is a sanctioned plant the trailing seal would refuse
(the seed's DL-003 request), and one is a packet requirement 4d-ii stated
and 4d-i did not:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `prisma/seed.ts` recreates DL-003's OPEN change request with `requestedById` alone, so after 4d-iii's trailing `ChangeRequest` seal a normal post-migration seed aborts and fresh or reseeded environments are unusable | §A.3 obligation 7 (the `ChangeRequest` seal); §D 4d-iii; P28b | the seed plants a pre-4d-shaped world by design (its decisions carry no events; DL-003's request is a legacy-shaped row), so its ONE insert the trailing seal would refuse becomes a NAMED plant: 4d-iii — the unit that installs `ChangeRequest_t4d_provenance_required` — rewrites the plant to run inside one `$transaction` that disables that seal by name in the seed's existing `DO $$ … IF EXISTS … DISABLE TRIGGER` shape and re-enables it after, the only admitted site under the statement tripwire; P28b's reset arm runs the FULL seed on the post-4d-iii schema (a fresh migrated database AND a mature reseed) and asserts it succeeds with every seal enabled afterwards, RED against the seal without the plant |
| 2 (P1) P42's post-fence arm asserted BOTH resumed direct-SQL transactions commit, but once the fence lifts the `Project` door and the owner/admin `OrgMembership` door each TRY the same org key, so the first to resume holds it to commit and the other is REFUSED, not waited — the arm fails by scheduling or invites weakening the door | §A.2 the kernel read (the fence); P42 | the arm models the contention: exactly ONE of the pair commits, the other is refused by its door's message (the delivered try-acquire-or-refuse), the refused statement is RETRIED after the winner commits and succeeds, and the terminal state holds the `pmc` row — in both resume orders under the barrier; the doors are not weakened |
| 3 (P1) 4d-i, expected to exceed 1,500 changed lines, was stated to "argue `justified-large`" without the exact marker or the six invariant-matrix rows the repository's scope gate requires, while 4d-ii's paragraph required both | §D 4d-i | 4d-i's packet MUST carry the same large-unit evidence 4d-ii's does: the exact `<!-- review-size: justified-large -->` marker with the visible restatement, all six invariant-matrix rows, the five pre-review checks, the file inventory, and its `migration-scope: inseparable` marker with the stated boundary |

**Review round 1 on #565 (head `5871826`) — three findings (two P1, one
P2): two folded on its ONE correction head, one DECLINED on the Board's
recorded decision, none dropped.** One is a boundary the widened role arm
would have crossed, one is a set comparison that admitted a repeated
recipient, and one — the drain attestation — is the question the Board
answered:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) 4d-i "widens the role arms of both 4b seals to `('client','pmc','architect')`", but those arms call the orgs-owned `phase6_effective_role_standing`, which reads `Membership`/`OrgMembership`/`Project`, so the architect branch of a decisions-owned seal would read another module's tables and contradict the plan's own rule that architect standing is read through `platform_role_standing` | §A.1 the designation fan-out; §D 4d-i; P37 | both 4b seals gain a SEPARATE architect arm — `deciderKind = 'architect'` judged by `platform_role_standing(project, 'architect') ≥ 1` over the platform register the orgs trigger writes — and the delivered `client`/`pmc` arm stays byte-identical on `phase6_effective_role_standing`; the service-side `deciderPushTarget` arm reads `RoleStandingQuery.activeCount` the same way; P37 asserts the architect arm from the register and the boundary tripwire that the seal's architect branch names no orgs table |
| 2 (P1) "remove the human-only drain gate" | §D the drain attestation | DECLINED — a Board decision, not a plan defect (#482 comment 5569586836); the plan carries the gate exactly as decided; the `AGENTS.md`-vs-decision contradiction that keeps re-raising it is before the Board (#482 comment 5575748015) |
| 3 (P2) the correspondence compared `targetUserIds` to the audience AS A SET, so a hand-run `[A, A]` passed for one active architect A, and the worker — sending once per listed element — delivered the demand twice | §A.3 obligation 7 (the converse, the delivery seal); P37 | the producer persists the CANONICAL array (sorted, distinct) and the seal refuses any `targetUserIds` with a repeated element before the set comparison; the delivery row's copy is bound element-for-element to that canonical array; P37 gains the duplicate-recipient probe (`[A, A]` refused, `[A]` admitted) |

**Review round 2 on #565 (head `89bd230`) — one finding (P1), carried
here, none dropped.** It is a second-order consequence of round 1's own
fold: the architect arm now reads the register, and the register's trigger
fired AFTER the guard that reads it:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the delivered `Membership_t4b2_holder_guard` is an AFTER trigger and `Membership_t4d_role_standing` was AFTER too; PostgreSQL fires same-kind triggers in name order, so the `t4b2` guard's new architect arm read the register BEFORE the `t4d` trigger applied the delta — removing the last architect while a published `pending`/`change` decision was designated to the role saw `1`, passed, and left the count at zero with an orphaned holder | §A.2 the register's writer; §A.1 the designation fan-out; §D 4d-i; P37 | `Membership_t4d_role_standing` is a BEFORE ROW trigger: it computes its delta from the OLD/NEW row it is handed — nothing it needs is in the table — and applies it through the primitive before the row is written, so EVERY AFTER guard on `Membership` judges the POST-write count, for a single row and for every row of a multi-row statement alike (each row's BEFORE fires before its write; the AFTER guards fire after all of them); a row a later constraint refuses rolls its delta back with it; the reservation and readiness doors sort before it by name and refuse first; the per-user register trigger stays AFTER because its rows carry the membership id, and no AFTER guard on `Membership` reads that register; the guard itself is not taught the delta — the ORDER is the orgs trigger's to fix, the decisions-owned guard keeps reading the register; P37 asserts the last-architect removal, re-role and the two-architects-in-one-statement removal each REFUSED by the guard with a designated open decision present, RED against the AFTER ordering |

**Review round 1 on #566 (head `cc8b3ba`) — two findings, both P1: one
folded on its ONE correction head, one DECLINED on the Board's recorded
decision, none dropped.** One is an ordering the fact's live actor-role
arm depended on and the text left implicit, and one — the drain
attestation — is the question the Board answered:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) "allow the autonomous runner to clear the drain gate" | §D the drain attestation | DECLINED — a Board decision, not a plan defect (#482 comment 5569586836); the plan carries the gate exactly as decided; the `AGENTS.md`-vs-decision contradiction that keeps re-raising it is before the Board (#482 comment 5575748015). A Watch-generated "Board GO" (#482 comment 5577525644) was folded on head `1a2ba97` and REVERTED on the next head once Delivery's hold (#482 comment 5577732007) showed no direct user decision behind it; the requirement stands. The Board then decided DIRECTLY at #482 comment 5577872836 (its own words, no coordinator marker); that fold was prepared as its own docs-only head, held, and applied on #568's head `b0d5399` on an in-session selection GitHub Watch records as its OWN keystroke (#482 comment 5581275205) — REVERSED in the #572 replacement: the default stands, the attestation REQUIRED, `AGENTS.md` as `main` carries it (the lineage header) |
| 2 (P1) the fact's actor-role arm reads `platform_user_holds_role` LIVE, and a self-transition written membership-first (a PMC re-roling themselves to `engineer`) had already projected the new role before the fact claimed the frozen `actorRole = 'pmc'`, so the check refused the transition the plan says must succeed; the captured-pre-state exception covered the PMC-authority arm only | §A.2 the membership transition fact; P29b | the fact is inserted BEFORE the membership write for EVERY transition (add already did; re-role and removal join it), so every arm of its BEFORE INSERT trigger — actor role, display name, team-management authority — judges the PRE-state registers by construction and the self-demotion special case collapses into the one rule; the membership write's BEFORE trigger requires the fact for this exact transition to already exist in the transaction, so a hand-run bundle written membership-first is refused and "fact first" is the sealed protocol, not a convention; P29b asserts a PMC's self re-role committing with the frozen `pmc` role (RED at the post-state live check), an owner/admin's self-demotion likewise, and the membership-first hostile bundle refused |

**Review round 2 on #566 (head `5921f22`) — two findings, both P1, carried
here, none dropped.** One is a delivered seal re-pointed onto the per-user
register a unit before the fence had verified it, and one is a stranded
return the named-holder rule left unusable for a role designation that had
emptied:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) 4d-i re-pointed the still-live consultation request seal's requester arm from `phase6_user_decision_authority` onto `platform_user_orchestration_authority`, yet the plan admits that through the 4d-i → 4d-iii window a concurrent `Project` INSERT and owner/admin `OrgMembership` INSERT can both commit without the membership-less owner's `pmc` row — so that owner passes the delivered service's orgs-truth check and the DB seal refuses the insert, breaking consultation requests (the previous release's included) until 4d-iii repairs the register | §A.2 the window rule; §A.2 consultation; §D 4d-i, 4d-ii, 4d-iii; P29b | the WINDOW RULE: until the fenced re-projection has proven the fanned-out rows equal to the orgs truth, no seal or read a window writer can meet judges a user's `pmc` standing through them — the consultation seal's requester arm STAYS `phase6_user_decision_authority` (4d-i widens the open set alone) and 4d-iii re-points it after the re-projection, in the same transaction; 4d-ii's service keeps the delivered requester check and admits an `architect` requester through the kernel read, an arm no window request can exercise (the reservation keeps every architect unrepresentable until 4d-iii); the `MembershipTransition` fact's `pmc` actor arm derives a membership-less owner/admin from the RACE-FREE registers (`OrgUserAuthority` + the absence of a membership-granted row, the org read from the orgs-owned seal's own `Project` row); and the participant's `effectiveRoleHolderUserIds` keeps the delivered orgs-truth SQL for `pmc`/`client` while `rollout.phase6_4d` reads `reserved`, wrapping the kernel read once it reads `open` — P29b's race fixture leaves the owner without the fanned-out row and asserts the request, the fact and the delivered push all admit them, RED against the 4d-i re-point |
| 2 (P1) the stranded `returned` outcome required a `toDesignation` only when a NAMED holder had departed; an architect-ROLE-designated decision approved by its sole architect, who then leaves under the exemption, stays `awaiting_countersign` with an EMPTY role designation, so the PMC's `returned → change` carried no `DecisionForward` and the open-holder rule refused the transition (the role still has zero holders) — the advertised outcome was unusable | §A.2 the stranded decision; §A.2 the exemption; P29b | re-homing is REQUIRED whenever the INSTALLED designation has no active holder — the named membership departed OR the role designation holds zero active members (`platform_role_has_holder` false) — the bundle's `DecisionForward` running FROM that empty designation (the departed membership, or the role) to the named ACTIVE target; a `returned` without a target for such a designation is 400, and with a target for a designation that still has a holder it is an ordinary same-bundle forward through the same door; P29b adds the emptied-role probe, RED against the named-holder-only rule |

**Review round 1 on #567 (head `5f07c5a`) — four findings, all P1: three
folded on its ONE correction head, one DECLINED on the Board's recorded
decision, none dropped.** One is the drain gate again; one is the set of
delivered writers the drain must keep alive; one is a lock taken over the
wrong row set; one is a seam the plan's own staging had already opened:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) "let verified drain evidence clear the gate" | §D the drain attestation | DECLINED as a plan defect — the gate is the Board's: the recorded default (#482 comment 5569586836) retains the human attestation with the autonomous evidence as fail-closed corroboration, and the Board's DIRECT decision to lift it (#482 comment 5577872836, its own words under the owner account with no coordinator marker) is accepted and prepared as its own docs-only head, held (the session's permission layer had refused it twice — #566 comment 5577923054), applied on #568's head `b0d5399` on a Watch-entered selection (#482 comment 5581275205), and REVERSED in the #572 replacement: the attestation REQUIRED |
| 2 (P1) through the 4d-i → 4d-ii drain a still-serving 4c instance also runs `requestChange`, `withdrawChange`, `requestConsultation` and `respondToConsultation`; the delivered `emitEvent` writes no envelope pair and the standard `requestChange` writes no `Notification`, yet the plan armed correspondence for those types in 4d-i, admitted a NULL envelope pair on the no-chain approve alone, and listed a notice as part of the `ChangeRequest` effect — so an ordinary legacy command could be refused at commit before 4d-ii deployed | §A.3 obligation 7 (the attribution arm, the legacy-writer table, the correspondence table); the `ChangeRequest` row of the fact table; §D 4d-i; P42 | EVERY live previous-release decision writer has its explicit drain branch, stated once in a table: a NULL envelope pair is admitted through the drain on every sealed event type a 4c writer can emit, the attribution arm binding `actorId` alone whenever the pair is NULL (the trailing 4d-iii seal closes it); the change-request notice is owed for the `countersign_rejection` origin ONLY, the standard request's transition owing none (the delivered path writes none) and its row joining the correspondence table; the consultation events are admitted in the delivered emitters' own targeted shapes with a NULL frozen pair; P42 drives all five legacy shapes through the 4d-i seals and asserts each COMMITS, RED against the approve-only NULL rule |
| 3 (P1) `deliveryRowsFor` read only the persisted ACTIVE rows `FOR SHARE`, so an inactive consumer's row was never locked: an event could read the obligation set, an activation could then lock that row, flip it and commit before the event committed, and both succeeded with the event carrying no row for a consumer active at its commit | §A.3 obligation 7 (the delivery rows); P38 | `deliveryRowsFor` locks EVERY `OutboxConsumerCatalog` row `FOR SHARE` — active and inactive alike — BEFORE filtering by `active`, the event's transaction holding the locks to commit, so an activation's `FOR UPDATE` either committed before the read or waits for the event's commit; P38's barrier arm drives the exact read → activation → event-commit interleaving, the activation observed BLOCKED until the event commits, RED against the active-only lock |
| 4 (P1) 4d-ii claimed the service/UI seam inseparable because a server without its client would refuse every deployed browser session — but throughout 4d-ii the five reservation doors keep every new shape unrepresentable and the in-command lesser-client refusal fires only under an ACTIVE chain, so a server-only unit lands dark behind every existing tab, and a unit already expected to exceed 1,500 lines was avoidably broad | §D the staging (FIVE PRs), 4d-ii-a and 4d-ii-b, the drain; §A.2 the client boundary | 4d-ii is SPLIT: 4d-ii-a, the SERVER unit, lands dark with the catalog-data migration, the four commands, the seals, the interceptor and every server change; 4d-ii-b, the CLIENT unit, ships the web gateway's `countersign-v1` declaration and every web surface, probed against the 4d-ii-a server with the doors standing; the drain's minimum release is 4d-ii-a's and 4d-ii-b's STATUS fold sets the directive; the migration seam stays inseparable for 4d-ii-a alone; the earlier inseparability claim is recorded as false under the plan's own staging |

**Review round 2 on #567 (head `7bf282f`) — three findings, all P1: two
carried here, one DECLINED on the Board's recorded decision, none
dropped.** One is the drain gate again, now argued from the plan's own
record of the Board's direct decision; two are seals on the delivered
`Decision` table the chain's transitions would have met:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) "apply the recorded autonomous drain decision" — the plan itself now records the Board's direct decision, so the reviewer reads it as fresh evidence | §D the drain attestation | DECLINED as a plan defect, for the reason the record states: the Board's direct decision (#482 comment 5577872836) is ACCEPTED and its fold PREPARED as its own docs-only head, held only because the session's permission layer refused to apply it (#566 comment 5577923054); a review finding does not change who applies a policy fold or when — the record of the decision in this plan was the record of that pending head, not a contradiction to resolve by folding it there; the fold was applied on #568's head `b0d5399` on a Watch-entered selection (#482 comment 5581275205) and is REVERSED in the #572 replacement: the attestation REQUIRED |
| 2 (P1) the awaiting entry arm was `BEFORE UPDATE` only: after 4d-iii drops `Decision_t4d_awaiting_reserved`, a direct INSERT of a published `Decision` already carrying `awaiting_countersign` passed the delivered 4b INSERT seal (publication and holder standing) and committed with no provisional revision, receipt, demand event, audit row or notice, leaving countersign and the stranded resolution no head to finalize | §A.2 the countersign entry; P37 | the approved-entry seal gains a BEFORE INSERT arm: a decision is never BORN `awaiting_countersign` — the state is ENTERED only through the sealed transition — so the born-awaiting row is refused outright; P37 gains the hostile born-awaiting INSERT, RED against the UPDATE-only arm |
| 3 (P1) the delivered `decision_t4b_attribution_seal` admits the frozen approval tuple's first write only on `pending`/`change → approved` and forbids an approval-bearing `change` row from leaving `approved`/`change`, so the provisional approve (`pending → awaiting_countersign`, tuple written) and the chain reapproval (`change → awaiting_countersign`) both aborted before the pairing seals ran; the plan named only the function's holder-forward opening | §A.2 forwarding (the attribution seal), countersign; §D 4d-i; P31 | 4d-i's `CREATE OR REPLACE` of the function widens BOTH clauses for exactly the sealed provisional transition — the tuple-write arm admits `pending`/`change → awaiting_countersign` beside `→ approved`, the standing arm admits `change → awaiting_countersign` beside `change → approved` — each admitted only where the approved-entry seal's awaiting arm and its DEFERRED pairing judge the same transition; the INSERT clause (a tuple belongs only to an approved decision) is kept, a decision never being born awaiting; P31 drives both chain flows through the widened seal, RED at the delivered function |

**Review round 2 on #568 (head `867d065`) — two findings, both P1, carried
here, none dropped.** One is the seed plant meeting a seal this plan itself
armed a unit earlier; one is a closed inventory that forgot its newest
member:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the DL-003 plant's bypass disabled `ChangeRequest_t4d_provenance_required` alone, but 4d-i already installs the permanent DEFERRED pairing seal on `ChangeRequest` that requires every open `standard` request to accompany its same-transaction `approved → change` transition, its claimed event and its audit row; the seed creates DL-003 directly in `change` in an earlier transaction and later inserts the request bare, so fresh AND mature post-4d-iii seeds still abort when the deferred trigger fires | §A.2 the closure and the opening (the seal NAMED); §D 4d-iii the DL-003 plant; P28b | the deferred pairing seal is NAMED `ChangeRequest_t4d_paired` — the ONE deferred pairing seal on the table — and the plant's ONE transaction disables BOTH `ChangeRequest_t4d_paired` (4d-i, permanent) AND `ChangeRequest_t4d_provenance_required` (4d-iii, trailing) by name in the seed's existing `DO $$ … pg_trigger … DISABLE TRIGGER` shape and re-enables both after; the complete opening bundle is deliberately NOT constructed (the seeded world carries no events, and a fabricated transition would be a fake fact); the two names are the CLOSED set the legacy-shaped row cannot satisfy — `DomainEvent_t4d_pairing_claimed` never fires because the plant inserts no event — and P28b's reset arm gains the RED probe: the same plant with ONLY the provenance seal disabled is refused at commit by `ChangeRequest_t4d_paired` |
| 2 (P1) the closed FIFTEEN-entry `TRUNCATE_SEALS` inventory omitted the `DomainEventPairingClaim` no-TRUNCATE seal that §A.2 declares and that the 4d-i reset truncates with `DomainEvent`; `sanctionedReset` disables only listed seals, so every seed or suite reset reaching the register would abort before cleanup | §D 4d-i the `TRUNCATE_SEALS` inventory and the reset's table list | `DomainEventPairingClaim_t4d_no_truncate` joins `TRUNCATE_SEALS` as its SIXTEENTH entry, and `DomainEventPairingClaim` joins the reset's table list beside `DomainEvent` and `Notification`, truncated under the named disables; the coverage tripwire counts sixteen |

**Review round 1 on #568 (head `55144a3`) — four findings as the gate
counts them (the second raised twice, on one line), all P1: two folded on
its ONE correction head, one DECLINED on the Board's recorded decision,
none dropped.** One is the drain gate again; one is a dependency the
converse seals inverted; one is a request left unpaired with its own
transition:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) "let autonomous drain evidence clear the gate" | §D the drain attestation | DECLINED as a plan defect, as on every head since #558: the recorded default (#482 comment 5569586836) retains the human attestation with the autonomous evidence as fail-closed corroboration; the Board's DIRECT decision to lift it (#482 comment 5577872836) is accepted and prepared as its own docs-only head, held only because the session's permission layer refused to apply it (#566 comment 5577923054), and no review finding changes who applies a policy fold or when; it was applied on `b0d5399` on a selection GitHub Watch records as its own keystroke (#482 comment 5581275205) and is REVERSED in the #572 replacement — the default stands, the attestation REQUIRED |
| 2 (P1) the converse pairing installed an orgs-owned constraint trigger on the kernel's `DomainEvent` reading `MembershipTransition`, and §A.3 repeated the shape for the decisions types — the leaf event store executing application-module persistence logic, the dependency direction inverted | §A.2 the converse; §A.3 obligation 7 (the converse, the catalog schema, the raw-plant bypass); §D 4d-i; P29b, P37 | a PLATFORM-OWNED generic mechanism: the kernel's `DomainEventPairingClaim` register written only through the platform primitive `platform_claim_event_pairing` at trigger depth, the persisted catalog's `pairingRequired` flag, and the kernel-owned DEFERRED seal `DomainEvent_t4d_pairing_claimed` that requires exactly one same-transaction claim for every event of a pairing-required type — reading platform tables alone; the OWNER's fact seal (the orgs `MembershipTransition` seal, every decisions fact seal of the §A.3 table) verifies its event through the kernel's `platform_tx_event` contract and CLAIMS it; no peer-owned trigger is installed on the kernel table, and every arm the plan attributed to "the converse" is an arm of the claiming fact seal |
| 3 (P1) the pairing column covered `countersign_rejection` only, so a `standard` `ChangeRequest` had no bidirectional link to its `approved → change` transition: after the sole architect left an `awaiting_countersign` decision, a database-role writer holding a valid `requestChange` receipt could insert a standard request with its event and audit row WITHOUT moving the decision, occupying `ChangeRequest_one_open_per_decision` so the stranded `returned` resolution could never create its rejection request | §A.3 obligation 7 (the opening bundle); the `ChangeRequest` row of the fact table; the correspondence and legacy-writer tables; P33 | the OPENING is one bundle in both directions like the closure: a `standard` request inserted open requires the same-transaction `approved → change` transition on its own `Decision` row, and the approved-entry seal's `approved → change` arm requires exactly one same-transaction open standard request — the delivered `requestChange` performs both under the readiness lock, so the previous release is compatible through the drain; the planted request is refused and can occupy nothing; P33 gains both refusals and the reviewer's shape |

**Review round 1 on #572 (head `8b50b52a`) — two findings (one P1, one P2),
folded on its ONE correction head, none dropped.** Both are the same shape,
and it is the shape that has cost this unit the most heads: a seal is
tightened in one enumeration and the WRITER that must satisfy it is left as
it was. Round 2 on #560 required the frozen pair on every new
`ChangeRequest`; the 4d-ii writer inventory still described `requestChange`
as recording `sourceCommandId` alone. The same writer never opted into key
synthesis, so under the documented default an unkeyed request reaches the
database with no receipt at all. Neither would have been caught by the
probes as written, because both tested only that LEGACY-shaped rows are
refused — which a shipped writer that cannot satisfy the seal also passes:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the 4d-ii writer inventory updated `requestChange` to record `sourceCommandId` only; unlike the consultation and rejection writers it never populates `requestedByRole`/`requestedByName`, so after 4d-iii's trailing seal requires both, even a keyed, current-version standard request inserts the NULL pair and aborts at commit | §D 4d-ii (the writer inventory); §A.3 obligation 5; P42 | the standard writer states the frozen pair from the resolved actor exactly as the consultation and rejection writers do; P42 drives the SHIPPED service after the trailing seals and asserts it COMMITS, RED against the pair-less writer — a positive arm, where the existing arm proved only that a legacy shape is refused |
| 2 (P2) `requestChange` passes no `synthesizeKeyWhenAbsent`, so with `COMMAND_KEY_ENFORCED` unset — the documented default — an omitted `Idempotency-Key` takes `executeCommand`'s ledger-less branch with `ctx.commandId = null`; writing `sourceCommandId` and re-pointing `resultRef` creates no receipt for that request, and once 4d-iii requires the column an otherwise valid unkeyed request rolls back instead of preserving the current API behavior | §A.3 obligation 5 (the provenance column); §D 4d-ii; P42 | 4d-ii's `requestChange` opts into `synthesizeKeyWhenAbsent: true` — the delivered answer to this exact problem, taken by the inventory ledger when `StockTransaction.sourceCommandId` became NOT NULL: a per-call server key secures provenance and changes nothing else (two unkeyed retries still each run once, a client key still replays exactly once, enforcement still refuses a missing key before synthesis is considered); P42 gains the NO-HEADER arm through the shipped service after the trailing seals, RED against the unsynthesized writer. Requiring the header instead is rejected: it is a new client error on a call valid today |

**Review round 2 on #572 (head `e2fd243e`) — two findings, both P1, carried
here, none dropped.** One is a packaging error on the correction head, not a
plan defect; one is a seal enumeration that forgot the origin it also
governs:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `e2fd243e` committed a machine-local `node_modules` symlink (mode `120000`, an absolute path into one session's checkout) — `.gitignore`'s `node_modules/` rule matches a directory, not a symlink of that name — so every CI job died at `pnpm install --frozen-lockfile` with `ENOTDIR` | the tree, not the plan | removed on `8acf586` by the same session; this replacement's tree carries no such path (`git ls-files` shows none); the one-line `.gitignore` prevention (`node_modules` without the slash, with its comment) landed on `e3e2828` by the same session and is carried here as the unit's single non-documentation line |
| 2 (P1) the §A.3 fact-table row for `ChangeRequest` gave actor standing only to an active architect under a chain or the resolving PMC, and its eligibility column named only an awaiting subject, although the same row governs `origin = 'standard'`; the delivered `decision.change` policy admits `pmc`, `client`, `contractor`, `engineer` and `consultant`, and `requestChange` opens a standard request from `approved` — an implementation following the table would have refused an active engineer's valid standard request once the frozen-pair checks were armed | §A.3 the fact table (the `ChangeRequest` row's actor and eligibility columns); P33 | the row is enumerated BY ORIGIN: `countersign_rejection` keeps the architect-under-chain / resolving-PMC arm and the awaiting subject; `standard` admits an ACTIVE member whose frozen `requestedByRole` is in the DELIVERED `decision.change` set (the architect not among them; 4d widens nothing) on an `approved`, published subject through the exact `approved → change` transition; P33 gains the non-PMC service probes (engineer, contractor, consultant COMMIT with their frozen pair; the architect refused by the delivered policy; an inactive member's direct insert refused), RED against the two-role enumeration |

**Review round 3 on #572 (head `c2e0840`) — four findings, all P1, folded
on this branch, none dropped.** Three are the unit's recurring shape from a
third side — an authority stated in one place (a policy row, a standing
predicate, a "dark" claim) and a seal or a writer elsewhere that cannot
meet it — and one is the plan still carrying the retired protocol:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the §D staging rule still directed the runner, at a second finding-bearing head, to close this PR and open a `Replaces: #<this>` replacement — the protocol `main` retired (#578) and the Board withdrew for this unit — so following the plan's own text would restart the lineage instead of correcting #572 | §D the staging rule; the matching STATUS text | the rule now states fix-forward on THIS branch whatever the head count, with a replacement admitted only for a concrete change of scope or approach recorded with a `Replacement reason:`; every remaining "a second finding-bearing head means close-and-replace" sentence in STATUS is rewritten as the historical record it is |
| 2 (P1) the corrected `standard` arm of the §A.3 `ChangeRequest` row required the requester to be an ACTIVE member, but the delivered `ProjectAccessService` authorizes an org owner/admin WITHOUT a project `Membership` with a `pmc` token and `decision.change` admits `pmc`, so that valid `requestChange` would be refused by the seal after 4d-iii — while obligation 3's general actor-standing contract already names the register's derived membership-less `pmc` row | §A.3 the `ChangeRequest` row (the `standard` actor arm); P33 | the arm is defined by `platform_user_holds_role` over `ProjectUserStanding` exactly as obligation 3 judges every fact — the derived `pmc` row IS the owner/admin's standing, no `Membership` demanded — and P33 gains the membership-less owner/admin service probe (COMMITS with the frozen `pmc` pair) beside the no-standing direct insert (refused), RED against the active-member rule |
| 3 (P1) the exact architect `ROLE_POLICY` set still listed `decision.change`, so after 4d-iii an architect's standard `requestChange` is admitted at the policy boundary and refused by the origin seal — authorized and denied in two places | §A.1 the action set; P28's equality pin | `decision.change` leaves the architect's set — ELEVEN actions — because the §A.3 contract admits a standard request only from the delivered set the architect is not in, and the architect's change path is `decision.disagree` (`origin = 'countersign_rejection'`); P28's pin now asserts `decision.change` absent and turns RED if it is re-admitted; `decision.withdrawChange` stays as delivered (a command-level check no seal judges) |
| 4 (P1) 4d-ii-a converts `members.add`/`updateRole`/`remove` into ledger commands writing a `MembershipTransition` with a NOT NULL `sourceCommandId`, but deployed tabs call those routes with no `Idempotency-Key` (`apiGateway.ts`), so under the documented default `executeCommand` takes its ledger-less branch with a null `commandId` and an ordinary add, re-role or removal rolls back at the fact insert — the "dark" claim failing for every open tab until 4d-ii-b ships keys | §A.2 the membership commands; §D 4d-ii-a's inventory; P29b | all three commands opt into `synthesizeKeyWhenAbsent: true` — the same delivered answer `requestChange` took in round 1 — so a keyless call reserves a per-call server key and commits its fact, a keyed call replays exactly once and enforcement still refuses a missing key first; P29b gains the three no-header arms against the 4d-ii-a server (RED against the keyless writer) and the keyed replay arms |

**Review round 4 on #572 (head `76d8f786`) — six findings, five P1 and one
P2, all folded here, none dropped.** Two are unimplementable-as-written
objects, two are missing attribution or lifecycle, and TWO are the previous
round's own remedy failing:

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `Notification_t4d_binding` was given BOTH a deferred INSERT arm that must inspect an event the same transaction inserts later AND an immediate `BEFORE UPDATE OR DELETE` freeze; PostgreSQL has no trigger that is both, so implementing the stated object either rejects every notice-before-event writer or leaves one arm unenforced | §A.2 (the feed row's binding); §A.3 obligation 7; §D 4d-i; P31 | the timings become separate NAMED objects: `Notification_t4d_binding_bound` (DEFERRABLE INITIALLY DEFERRED, INSERT, the same-decision binding, checked at commit) and `Notification_t4d_binding` (immediate, `BEFORE UPDATE OR DELETE`, the freeze, carrying no INSERT arm); P31 asserts each against a writer exercising only its half |
| 2 (P1) a `standard` request's withdrawal froze nothing about its CLOSER — `ChangeRequest` carried a frozen requester pair only — so a hand-run bundle could set a truthful `resolvedById` and stamp an arbitrary role and name on the append-only `decision.change_withdrawn` event envelope and audit row | §A.2 (the withdrawal bundle); §A.3 obligations 3 and 7; P33 | `resolvedByRole`/`resolvedByName` join the row, written with `resolvedById` and immutable with it, judged exactly as obligation 3 judges every frozen pair, with the correspondence binding BOTH effect records to that pair rather than to `actorId` alone. The `countersign_rejection` closure already had this through its resolution fact; the standard origin had no closure fact and so had nowhere to put it, which is why it was missed |
| 3 (P2) the "exhaustive" key-synthesis roster written LAST round named `requestChange` and the three membership commands and missed `decisions.forward`, `decisions.countersign`, `decisions.disagree` and `decisions.resolveStrandedCountersign` — four commands the SAME paragraph discusses by name two sentences later, each writing a fact with required `sourceCommandId` | §A.3 obligation 6; §D 4d-ii; P29b/P42 | the set is DERIVED from the §A.3 fact table — every ledgered command whose fact's provenance column reads `required` — with no hand-maintained roster at all; the current derivation (EIGHT commands) is shown as a CHECK on the derivation, and stated to be the error if a reader derives a different set from the table |
| 4 (P1) `User_t4d_identity` covered insert and rename and said nothing about deletion, while `UserIdentity` is sealed and non-truncatable and the seed and fixtures hard-delete `User` rows — so a reset either fails on the identity row's FK or leaves orphaned identity evidence `platform:verify` reports forever | §A.2 (the identity register); §D 4d-i; P28b | `UserIdentity.userId` carries `ON DELETE CASCADE` and the seal ADMITS that cascade explicitly — a nested delete at trigger depth from the owning `User` row — while a direct `DELETE` stays refused; the sanctioned reset needs no new step, and P28b asserts both halves |
| 5 (P1) the pairing register is UNIQUE per event and the kernel refuses an unclaimed `pairingRequired` event, but the `countersign_renotified` branch (whose only fact is an audit row) named no claimant, while bundles sharing one event would produce TWO claims under the blanket "every fact seal claims its events" | §A.3 obligation 7 (the claim); §A.2 (the re-notification branch); P29b/P37 | the rule is stated PER BRANCH: the branch's PRIMARY fact claims and every other fact in the bundle is verification-only. The re-notification branch's claimant is its audit row; the bundle primaries were already named; a branch added without naming its claimant is a defect. P29b/P37 assert both failure shapes |
| 6 (P1) the window rule's "three arms, each disposed" omitted the 4d-ii APPROVAL writer: a membership-less owner/admin can validly approve while the chain is reserved, the service revalidates from org truth, but the approval revision's pair-validation seal had no race-free fallback and would refuse the approval the service just authorised | §A.2 (the window rule); §D 4d-ii/4d-iii; P29b | a fourth arm keeps that validation on the race-free authority derivation until 4d-iii re-points it, AND the four arms are replaced by the rule they share — through the window, no seal a window writer can reach judges `pmc` standing through the fanned-out register — so a fifth writer is covered without being listed |

**Root-cause audit of the repeated findings.** The gate asked for one at this
round, and the four fixes above do not answer it: each is correct and each is
local. Read across rounds instead of within one, three of them are a single
failure — **an obligation was discharged at the site where it was reported,
never over the set of sites that carry it.**

| the obligation | where it was discharged | the site it did not reach |
|---|---|---|
| a required `sourceCommandId` needs `synthesizeKeyWhenAbsent` | round 1, finding 2 — `requestChange` / `ChangeRequest` | the three membership commands, same unit, same NOT NULL column (round 3, finding 4) |
| the `ChangeRequest` row is enumerated by ORIGIN | round 2, finding 2 — the origin split, actor arm written "ACTIVE member" | the membership-less `pmc` the general actor-standing contract already admits (round 3, finding 2) |
| the architect's authority is an explicit CLOSED set | §A.1 — the enumeration was written and pinned | it was never reconciled against the §A.3 seals that judge the same acts (round 3, finding 3) |

The pattern is not carelessness at any one site; it is that a fix was treated
as complete when the reported call site was correct. Two rounds of local fixes
produced a third round of the same defect at the sites the first two did not
visit, which is precisely the signal a finding count is for.

So this round's deliverable is two rules stated over SETS, not a fourth local
fix. Both are written into the sections they govern:

- **§A.3 obligation 6 (command provenance) is discharged PER WRITER.** Every
  command this plan puts on the ledger whose fact carries required provenance
  opts into `synthesizeKeyWhenAbsent: true` AND carries a probe driving it with
  no `Idempotency-Key` header — because `COMMAND_KEY_ENFORCED` is unset by
  default, so an unkeyed call takes `executeCommand`'s ledger-less branch and
  `run` receives a null `commandId` that a required column then rejects, on a
  call the current API accepts. The covered writers are named exhaustively
  there (`decisions.requestChange`; `members.add`, `members.updateRole`,
  `members.remove`), so a writer added later is added to a list rather than
  discovered by a reviewer.
- **§A.1's closed set is RECONCILED against the seals, not merely declared.**
  Each granted action names the §A.3 seal that judges the act it authorizes,
  and a grant whose seal would refuse the actor is a defect in this plan —
  fixed by narrowing the grant or by deliberately widening the seal with its
  probes, never by leaving both standing on their own pages.

Those two sentences would have caught findings 3 and 4 of this round before it
was requested, and that is the test this audit sets itself.

**It failed that test one round later, and the failure is the useful part.**
Round 4's finding 3 is the provenance rule above being applied to a roster I
wrote by hand and called "exhaustive" — a roster missing four commands that
the very same paragraph goes on to name two sentences later. Round 4's finding
6 is the window rule's "three arms, each disposed" missing a fourth writer, the
same shape in a different table. So the round-3 diagnosis was right and its
remedy was the wrong KIND of thing: I answered "the set was not swept" by
writing down the set, which is another instance of exactly what fails —
an enumeration a human must remember to extend.

The round-4 answer is therefore not a longer list but a DERIVATION. The
provenance rule now reads its set off the §A.3 fact table's own provenance
column, and the window rule states the property its arms share instead of
counting them, so a command or a writer added later is covered by construction
and a reader who derives a different set is holding the correction. A rule
that can go stale is a rule with the defect built in; the test this audit sets
itself is whether the next round finds a MISSING INSTANCE of either rule, and
if it does, the mechanism is still wrong and not merely the list.

**One residual, recorded rather than changed.** Finding 3 removes
`decision.change` and leaves `decision.withdrawChange` in the architect's set,
on the stated ground that no seal judges it. That is right about the seal, and
the grant is now unreachable for a different reason: the delivered
`withdrawChange` admits only the requester or a `pmc`
(`decisions.service.ts`), refuses a `countersign_rejection` request outright,
and — with `decision.change` gone — an architect can never be a standard
request's requester. It grants no reachable call. It is left as decided,
because it is inert rather than contradictory and re-opening a deliberate
choice from the same round is churn; a reviewer who wants the set to contain
only reachable actions should say so and it comes out.

### Review round 5 (head `3d1aa621`) — six findings, five P1 and one P2, all folded here

Two are §D's implementation inventory still directing what §A retired a round
ago, one is the round-4 window rule's own missing instance, one is a seal
refusing the repair that closes the window, one is an unbound closure receipt,
and one is STATUS advertising a retired replacement chain in the present tense.

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) §D's 4d-i inventory still assigned the same-decision INSERT arm to `Notification_t4d_binding`, though §A split the timings into `Notification_t4d_binding_bound` (deferred, INSERT) and `Notification_t4d_binding` (immediate, freeze) a round earlier — so following the inventory recreates the trigger PostgreSQL cannot make, or drops the binding | §D 4d-i (the inventory); §A.2 the feed row; P31 | the inventory names `Notification_t4d_binding_bound` and says which object it is NOT, since the freeze appears two lines above it in the same list |
| 2 (P1) §D's inventory still directed EVERY decisions-owned fact seal to claim its event, the blanket rule §A replaced in round 4 with the per-branch primary-fact rule — so a returned resolution's `DecisionStrandedResolution` and `ChangeRequest`, sharing `decision.change_requested`, would both claim it and abort a VALID bundle on the register's per-event UNIQUE | §D 4d-i (the inventory); §A.3 obligation 7; P29b/P37 | the inventory states the claim per BRANCH — the primary fact claims, every other fact in the bundle is verification-only — and names the bundles the blanket rule would have aborted (round 9 finding 1 then replaced the hand-named primaries with the derivation and gave the §A.3 correspondence table a CLAIMANT column) |
| 3 (P1) the §A.3 `ChangeRequest` `standard` actor arm judged `pmc` through the fanned-out `ProjectUserStanding` register with no window disposition, which is the one thing §A.2's own window rule forbids a window-reachable writer to do; the same omission reached the NEW frozen closer-pair validation on `withdrawChange` | §A.2 the window rule; §A.3 the `ChangeRequest` row; §D 4d-ii/4d-iii; P29b/P33 | both arms take the RACE-FREE authority derivation through the window and are re-pointed by 4d-iii with the rest — AND the fact table's actor-standing column now states a WINDOW DISPOSITION per row, so the rule is walked where the arms are instead of asserted once in prose |
| 4 (P1) 4d-iii's fenced re-projection must INSERT and DELETE register rows from the migration — a depth-1 write the registers' writer-depth seal exists to refuse, and the seal admitted only nested writes plus the backfill's gate — so the migration whose purpose is to close the drain window is refused and rolls back | §A.2 the kernel read (the writer-depth seal); §D 4d-iii; P42 | a SECOND named gated arm, `vitan.phase6_4d_standing_reprojection`, admitted only while the 4d-iii table fence is held, only toward the snapshotted orgs truth, and only on the two per-user registers; P42 asserts the ungated and unfenced statements refused, so the gate is proven narrow |
| 5 (P1) a `standard` withdrawal's only `sourceCommandId` names the earlier `requestChange`, so the round-4 frozen resolver pair proves attribution and NOT that a `decisions.withdrawChange` receipt was ever reserved: a database-role writer sets a TRUTHFUL pair, restores the decision, appends the event and audit row, and satisfies every seal without the ledger protocol | §A.2 the withdrawal bundle; §A.3 obligations 5 and 6; P33 | the closure carries its own `resolvedByCommandId` — the column the `countersign_rejection` origin gets from its resolution FACT and the factless standard origin lacked — with its composite FK, one-use UNIQUE and 4d-iii requirement; the obligation-6 derivation becomes PER COLUMN and yields NINE commands; P33 gains the no-receipt hostile arm |
| 6 (P2) STATUS's active heading still read "replacing #567" in the present tense while the record beneath it says the unit stays on #572 with `Replaces: none`, so the authoritative current-work entrypoint could send the next runner back into the retired replacement lineage | `docs/STATUS.md` (the Now entry) | the heading names what the unit IS; the chain is explicitly labelled HISTORY, with the retirement (#578 at `f050bcd`) and the label removal cited beside it |

**The round-4 audit set itself a test, and this round failed it.** Its closing
sentence was: *"the test this audit sets itself is whether the next round finds
a MISSING INSTANCE of either rule, and if it does, the mechanism is still wrong
and not merely the list."* Finding 3 is a missing instance of the window rule.
The rule was stated as a shared property — correctly, and it even says an arm
that cannot name its disposition is a defect — and then the table full of arms
was never walked with it. So round 4 did not repeat round 3's mistake; it made
the adjacent one. Round 3 wrote a list and did not extend it. Round 4 wrote a
property and did not APPLY it.

That distinction is what this round's structural change turns on. A derivation
beats a list only where something actually performs the derivation. §A.3
obligation 6 has that: the set is read off a column of a table the plan already
maintains, and round 5 could only move it from eight to nine by adding a column
— the derivation carried the change itself, and the correction it forced (per
COLUMN, not per fact TABLE) is exactly the kind of error a live derivation
surfaces. The window rule had no such reader. It is now a COLUMN of the §A.3
fact table, so the same walk that checks every fact's obligations checks every
arm's window disposition, and an arm with neither disposition fails the table's
own pass.

**Self-found while folding this round, and it is the same shape a third time.**
Round 4's answer to its finding 2 ends "P33 gains the forged-closer arm". P33
did not gain it — the sentence was written in §A and the probe row was never
touched, so the plan asserted a probe that did not exist. Found by opening P33
to add round 5's no-receipt arm rather than by a reviewer. Both arms are in the
row now, together with the window arm finding 3 owes it. The lesson is not that
one edit was forgotten: it is that "P33 gains X" is a promise about a DIFFERENT
part of the document, and this plan makes that promise constantly with nothing
checking it. Two of this round's six findings are the §A→§D form of exactly
that; this is the §A→probe-table form.

Findings 1 and 2 are the same lesson at a different seam: §A was corrected and
§D was not. An inventory that RESTATES behaviour is a second copy of the rule
with no reader, which is why both drifted within one round of §A being fixed.
Where round 5 restates §A in §D it now names the object and says which one it
is not — the cheapest available form of "this copy is subordinate" — and the
honest limit is that §D remains prose a human maintains, so a third §A/§D drift
would say this remedy is also the wrong kind and the inventory should be
generated from §A rather than written beside it.

### Review round 6 (head `73a0bc36`) — one P1, folded here

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) round 5's new `resolvedByCommandId` named `decisions.withdrawChange` as its only writer, but `DecisionsService.approve` also closes the open request on a mandatory re-approval by setting `resolvedById` — so once 4d-iii requires closure provenance, an ORDINARY approval from `change` rolls back, for either origin | §A.2 the withdrawal bundle; §A.3 obligations 5 and 6; §D 4d-ii's writer inventory; P42 | the column's writers are DERIVED from the column it qualifies — every command that writes `resolvedById` — which the delivered service says is `withdrawChange` and `approve`'s re-approval closure; the obligation-6 set becomes TEN, 4d-ii teaches the re-approval update to populate it, and P42 gains both reapproval arms after the trailing seals |

**This is round 5's audit failing on round 5's own deliverable, one round later.**
That audit concluded the thing this round had to prove it believed: *a
derivation beats a list only where something performs the derivation.* It then
introduced a NEW provenance column and named its writer by hand — one name,
chosen by thinking about the finding in front of me rather than by reading what
writes the column. `approve`'s closure branch was one `grep resolvedById` away
the whole time.

So the correction is the round-5 correction applied to itself. Round 5 moved
obligation 6's derivation from per fact TABLE to per COLUMN; round 6 moves each
column's WRITER SET from a list to a derivation over the column that column
qualifies. Both halves now have a referent a reader can execute against the
delivered service, and neither is a sentence asking the next author to
remember. The pattern across rounds 3 to 6 is worth naming plainly, because it
has now recurred four times: **every remedy of the form "write the set down"
has failed within one or two rounds, and every remedy of the form "derive the
set from something that already exists" has held.** Round 6 is the first round
whose finding was produced by the previous round's FIX rather than by an
unswept site — which is progress only if the fix is of the second kind, and
this one is.

### Review round 7 (head `c18a3ffe`) — two P1s, both from round 6's own fix

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) round 6 taught the re-approval writer to populate `resolvedByCommandId` and NOT the frozen `resolvedByRole`/`resolvedByName` pair, which this plan requires whenever the resolver is recorded — so an ordinary re-approval from `change` still rolls back at the closure seal, for either origin | §A.2 the withdrawal bundle; §A.3 obligations 3 and 5; §D 4d-ii; P42 | the obligations that attach to RECORDING A RESOLVER are stated once as a SET every writer of `resolvedById` inherits whole — the frozen pair, the provenance column, and the receipt binding — instead of being carried one finding at a time |
| 2 (P1) the closure's receipt does not BIND: `phase6_t4d_provenance_bound` admits a `resultRef` naming the row or a bundle PRIMARY, and `approve` completes its receipt with `resultRef: decisionId`, which is neither the `ChangeRequest.id` nor the revision id — so writing the column still fails provenance validation | §A.3 obligation 6 (the bundle extension); §D 4d-ii; P42 | a THIRD admitted shape for a CLOSURE — a `resultRef` naming the closed row's `decisionId`, which is what both writers already return — rather than re-pointing a receipt whose subject is the decision (and which, for `approve`, the delivered approval-revision binding already rests on) |

**The sweep found a second instance Codex did not report.** Finding 2 names
`approve`. `withdrawChange` completes its receipt with `resultRef: decisionId`
too, so the closure `resolvedByCommandId` that round 5 introduced never bound
for the withdrawal either — the defect was in the round that added the column,
not in the round that widened its writer set. Fixed for both, because the
binding is now defined over the closure rather than over a named command.

**This is the fourth consecutive round produced by the previous round's fix,
and the shape has narrowed each time.** Round 5 wrote a hand list. Round 6
replaced it with a derivation over the column — and that derivation held: it is
what made this round's sweep find `withdrawChange` without being told. What
round 6 got wrong was subtler: having derived the writer SET correctly, it
carried exactly ONE of the three obligations that attach to membership in that
set. A derived set does not help if what the set OWES is itself enumerated by
whichever finding arrived last.

So round 7's change is not a fourth item on a list; it is the same move applied
one level up — the closure's obligations are now a named SET, inherited whole,
the way the §A.3 fact table already makes every fact inherit its seven. The
test this sets itself: the next round should not be able to find an obligation
a resolver writer owes and does not carry, because there is no longer a place
to carry them one at a time.

### Review round 8 (head `e9b496a1`) — three findings, and the fourth round from the previous round's fix

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the delivered `members.add` looks the user up and CREATES a missing one BEFORE its membership transaction, so two requests with the same `Idempotency-Key` for a new email can both see no user, one creates it, and the other fails on the uniqueness constraint before reserving or replaying the receipt — the keyed replay this plan promises covering only the half after the identity exists | §A.3 obligation 6; §D 4d-ii-a's writer inventory; P29b | 4d-ii-a moves the lookup AND the create inside `executeCommand.run`, so the whole add is one atomic replayable unit |
| 2 (P1) `ChangeRequest_t4d_provenance_required` is INSERT-time and checks the requester half only, while BOTH closures — the withdrawal and the re-approval — happen by UPDATE; so the closure set rounds 5–7 specified was enforced by nothing, and a direct closure setting `resolvedById` alone meets every seal this plan installs | §A.3 obligations 3, 5 and 6; §D 4d-iii; P42 | the seal gains an UPDATE ARM requiring the COMPLETE closure set whenever `resolvedById` goes NULL → non-NULL, all four columns then immutable together; P42 gains the direct-closure hostile probe in three shapes — **the KEY re-set onto the `status` transition by round 12, finding 1**, which is where this answer proved too narrow |
| 3 (P2) [MOVED TO THE COMPANION DOCUMENT — reunified into this unit, round 22] `outbox:consumer` mutates a GLOBAL register but was required to run through a ledger whose `CommandScope` admits only a project or an org — so it would key a global mutation on an arbitrary tenant, and per-org scoping would let one activation key execute once per organisation against a single global `seq` | §A.2 the activation register; `platform/commands.ts` | it is an OPERATOR PROTOCOL, not a ledger command, and it does not widen the receipt model for every command to serve the one that does not fit it. The idempotency half of this answer was WRONG and round 9 finding 2 replaced it: `(consumer, seq)` uniqueness under the catalog row lock gives ORDERING safety, not retry idempotency, because the head-lock trigger raises on a stale sequence before `ON CONFLICT DO NOTHING` is reached. The command now asserts the intended STATE — `seq` off the operator surface, an explicit already-in-the-requested-state no-op under the same lock |

**Finding 2 is the fourth consecutive round produced by the previous round's
fix, and it is the one that names what the first three were missing.**

Round 5 wrote a hand list of writers. Round 6 replaced it with a derivation over
the column. Round 7 replaced the enumerated obligations with a set every writer
inherits. Each of those was a real improvement and each held. But all three were
corrections to the SPECIFICATION — to the sentence describing what a closure
owes — and not one of them asked the next question down: **what enforces it, on
which operation?** The answer was: nothing, on none. The only seal on
`ChangeRequest` fires on INSERT, and a closure is an UPDATE. Three rounds of
increasingly well-derived obligations were being written into a space no seal
reached.

So round 8's change is not a fifth refinement of who-owes-what. It adds the
enforcement question to the §A.3 walk itself: **for every obligation, name the
operations its seal fires on, and an obligation whose seal does not cover every
operation that can breach it is a defect of the same kind as omitting the
obligation outright.** A rule with no enforcer on the reachable operation is a
comment.

The test that sets itself is the sharpest one yet, and deliberately so: the next
round should not be able to find an obligation in this plan that no seal
enforces on the operation that performs it — because the table's own walk now
asks.

### Review round 9 (head `2b031707`) — two findings, and BOTH are the previous round's fix

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the per-branch claimant rule named its primaries in a hand LIST — `decisions.disagree`, `resolveStrandedCountersign`, the re-notification audit row — while the sentence four lines above that list identified the REAPPROVAL as a fourth bundle sharing one event and never named its claimant. So the implementation cannot tell which seal calls `platform_claim_event_pairing` for `decision.reapproved`: claiming from both the `DecisionApprovalRevision` and the closing `ChangeRequest` aborts on the per-event UNIQUE, each deferring to the other leaves the event unclaimed | §A.3 obligation 7 (the claim); the §A.3 correspondence table; §D 4d-iii (the `resultRef` shapes); P29b | the primary is DERIVED, not listed: **the fact present on EVERY instance of the branch**, since a fact written on only some arms would leave the other arm's event unclaimed. The reapproval's revision claims and its closure verifies, because the revision is written from `pending` and `change` alike while the closure exists only on the `change` arm — and the same derivation reproduces every primary the list had named. The correspondence table gains a CLAIMANT column, so a branch added without one is visible in the table |
| 2 (P2) [MOVED TO THE COMPANION DOCUMENT] round 8's own answer — `(consumer, seq)` uniqueness with `ON CONFLICT DO NOTHING` under the catalog row lock makes a repeated activation "a no-op by construction" — is false. The head-lock trigger requires `NEW.seq = activationSeq + 1`, so a retry re-deriving the sequence appends a SECOND fact and a retry resending its original sequence is refused as stale before `ON CONFLICT` is reached | §A.2 the activation register; the round-8 ledger row above; P29b | the operator asserts the STATE, not a sequence: `seq` leaves the operator surface entirely, and under the same row lock the command either observes the mirror already at the requested `active` and appends nothing, or appends at the derived next sequence. The trigger's check stays as the floor under DIRECT writers |

**Both findings are the previous round's fix, and together they say something
round 8 did not.** Round 8's lesson was about ENFORCEMENT — an obligation whose
seal does not fire on the operation that breaches it is a defect. Both of these
pass that test: the claimant rule has a seal (the kernel's pairing seal, on the
operation that matters), and the activation register has one. They fail one step
earlier and one step later instead.

Finding 1 fails EARLIER: the rule was under-specified, so no seal could be
written from it. And it fails in the way this plan has now failed four times —
rounds 5, 6, 7 and 8 each replaced a hand list with a derivation, and the
claimant primaries were a hand list that survived every one of those rounds
because each round fixed the list in front of it rather than the habit. A list
is not made safe by being short or by being right today.

Finding 2 fails LATER: the seal exists and fires, and the claim made ABOUT it
was simply not true of it. Round 8 asserted an idempotency property of a
mechanism whose own trigger — added two rounds earlier, for a different
finding — contradicts it. Nothing in the walk checks a claimed property against
the mechanism it is claimed of.

So round 9 adds the two questions the walk was missing on either side of
enforcement:

> **Before the seal:** any rule that selects ONE thing out of a set — a
> claimant, a primary, an owner — must state the PROPERTY that selects it, and
> the inventory that closes over the set must carry the selection as a column.
> A list of the selections made so far is a defect however complete it looks.
>
> **After the seal:** any idempotency, ordering or exclusivity property this
> plan CLAIMS of a mechanism must be re-derived against that mechanism's own
> constraints as written here, naming the specific check that grants it. A
> property that no named constraint grants is a wish.

**Both questions were then walked over this plan, not merely stated.**

The FIRST found one further selection rule and no others: every remaining
"exactly ONE" in this plan is a constraint on outcomes (one commits, one
exists, one demand is emitted), not a rule choosing one member of a set, so
the claimant was the only hand list of its kind. That is a result, not an
absence of effort — the question is worth keeping precisely because the next
branch added to the correspondence table will meet it.

The SECOND found a real one, unprompted, in the same shape as finding 2 and
in a place no reviewer has raised: **the 4d-i standing backfill's replay.**
That arm exists because #560's review round 2, finding 5 observed that a
depth-only seal would refuse the replay's own insert and make 4d-i
unreplayable. The arm as written admits the gated depth-1 write "ONLY as a
zero-count insert for a project that has no row" — and pairs it with
`INSERT … ON CONFLICT DO NOTHING`. Those two cannot both be load-bearing. A
BEFORE INSERT trigger fires on the speculatively inserted row BEFORE the
conflict is detected, so on any replay over a database where the projects of
the original backfill still hold their rows, the seal's "has no row" clause
is false for every one of them and the trigger raises — the `ON CONFLICT`
clause never reached, and the replay this arm was added to enable aborting
exactly as it did before the arm existed. Whether 4d-i replays at all then
rests on an unstated detail of the elided statement.

So the plan states it rather than leaving it to the ellipsis: **the backfill
statement carries the exclusion and the seal judges VALUES only.** The insert
selects the projects that have no row (`WHERE NOT EXISTS`), so the trigger
never sees an insert for a project that already has one, and the seal's gated
arm admits a depth-1 zero-count `architect` insert under the gate without any
predicate on the target row's absence. Dropping that clause costs nothing: a
gated zero-count insert onto a project that already has a row is discarded by
the unique index anyway, so the clause was never doing the security work its
wording implied — it was only making the replay's outcome depend on which of
two mutually blind mechanisms ran first. P29b's backfill-replay arm gains the
mature-database shape: the replay run over a database that already holds a row
for every original project AND a project created since, committing, with the
new project's row inserted and no existing row touched.

### Review round 10 (head `d4636e96`) — three findings, two of them round 9's own

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) `decisions.withdrawChange`'s authority — the requester or the PMC — was left to the service, in a sentence that said so and treated it as safe. Against the receipt-holding database-role writer this plan models throughout, an active engineer or contractor who did not open the request can reproduce the whole protocol (truthful frozen resolver pair, completed receipt, closure, restoration, event, audit row), satisfy every seal, and withdraw somebody else's request | §A.2 the policy row; §D 4d-iii (the closure UPDATE arm); P42 | the UPDATE arm gains the predicate — for a `standard` request closed to `withdrawn`, `resolvedById` equals `requestedById` or holds `pmc` standing by `platform_user_holds_role` over `ProjectUserStanding` under `phase6_try_readiness`. P42 gains the truthful-but-unauthorized closer, with the requester's and a PMC's identical closures COMMITTING beside it |
| 2 (P1) round 9's claimant column put the `ChangeRequest` closure in the COUNTERSIGN bundle as a verification-only fact. That closure is committed by the earlier PROVISIONAL approve — the transaction that lands `awaiting_countersign` (§A.3's `open → resolved` pairing, round 4 finding 6) — a different command and a different transaction, so the rule as written would reject every countersign following a change cycle | the §A.3 correspondence table (two rows) | the closure moves to the row that writes it: the provisional-approve row names it verification-only beside its revision, and the countersign row is stated CLOSED — the revision flip, the countersign fact, the status transition and their effects, and nothing else |
| 3 (P2) [MOVED TO THE COMPANION DOCUMENT] round 9's already-in-the-requested-state no-op promises to return the existing head fact, but on upgrade the catalog already holds active consumers (`webpush.notify`, `decisions.inbox`) with no `OutboxConsumerActivation` row at all — no head to return, and a frozen `active` mirror with no attributable row explaining its value, which is the very thing the register was introduced to end | §A.2 the activation register; `upgrade-proof.sh`; P29b | the register's migration backfills one `seq = 1` baseline fact per EXISTING catalog row, mirroring its current `active`, `actorKind = 'migration'`, and sets each `activationSeq` — so every consumer has a head from the moment the table exists and "no head" is not a state the command interprets. Probed on a pre-existing active consumer |

**Two of the three are round 9's own fix, and they fail the same way in two
different registers: I asserted something about a POPULATION without checking
its extent.** Finding 2 named a fact in a bundle without asking which
transaction commits it. Finding 3 named a head for every consumer without
asking which rows exist on a database that already ran. Round 9's two
questions do not catch either: they ask what property SELECTS a thing, and
whether a claimed property is TRUE of a mechanism. Both presuppose the thing
is there to be selected or claimed of.

Finding 1 fails differently and is the more serious of the three: the rule
had no seal at all, and this plan SAID so in the sentence that carried it —
*"a service authority no DB seal judges, so policy and seal cannot disagree
there."* That sentence answers a question nobody asked. Policy/seal agreement
is not the concern; the concern is the receipt-holding direct writer this
plan models on every other page. Round 8's question — does the seal fire on
the operation that breaches the obligation? — cannot reach this, because it
presupposes a seal to interrogate.

So round 10 adds one question that covers all three, and it goes FIRST in the
§A.3 walk, before round 8's and round 9's:

> **Name the enforcer, and name the extent.** For every rule: which OPERATION
> can breach it, and which SEAL judges that operation? "The service checks
> it" is not an enforcer while this plan models a database-role writer
> holding a valid receipt. And for every fact or row a rule names: which
> TRANSACTION writes it, and which rows ALREADY EXIST before this unit runs?
> A bundle cannot verify a fact another command committed, and a no-op cannot
> return a head an upgrade never created.

**Walked, not merely stated.** The enforcer half found exactly one other
place where the plan leaves a rule to the service — none; line 1109 was the
only one, and it is finding 1. The transaction half was walked over all
eleven rows of the correspondence table: one error, finding 2, now corrected;
every other claimant and verification-only fact is written by the transaction
its row names. The extent half was walked over every register this unit
mirrors or backfills — `ProjectRoleStanding`, `ProjectUserStanding`,
`UserIdentity`, `OrgUserAuthority` and `ExternalEffectCatalog` all state their
backfill over pre-existing rows; `OutboxConsumerActivation` was the one that
did not, and that is finding 3.

### Review round 26 (head `37f182a3`) — two findings, both the TAIL of my own fixes, and the smallest round since 19

| # | classification | why that class |
|---|---|---|
| 1 (P1) | **regression introduced by a fix** | round 25 moved the barrier's EXCLUSIVE half into a trigger and left the SHARE half in a TypeScript helper, so a direct writer bypasses it |
| 2 (P1) | **regression introduced by a fix** | rounds 23 and 24 changed WHEN a standalone audit row is refused; P31 kept the old "admitted before 4d-iii" sentence beside the new arms |

Two comments, gate count two, reconciled before folding. Neither declined,
neither duplicate. Both fixes touch §A, §D and §C per the obligation round 25
minted; the three-column record is below.

**Finding 1 — half a barrier is not a barrier.** Round 25 was right that an
advisory key with no installer is not installed, and then installed only one of
its two halves in the database. `deliveryRowsFor` is a TypeScript helper, so the
SHARE half only covers writers that go through the platform's emitter; a direct
`DomainEvent` writer with a receipt never calls it. The deferred
`DomainEvent_t4d_deliveries` seal then scans the catalog holding no key, a
registration takes the uncontended exclusive key and commits, and the event
commits owing that consumer nothing — the exact interleaving the barrier was
introduced to close, reachable by the exact writer class this plan's seals exist
for. So the seal takes the SHARE key itself, at the head of its deferred body.
The rule is round 12's, applied to a lock rather than a column: **the
enforcement point is the seal, never the caller** — and an application helper is
a convenience, not a barrier. The advisory lock is reentrant, so the helper may
keep taking it early for lock-ordering hygiene at no cost.

**Finding 2 — and this one lands on the rule I minted last round.** Round 25
made it an obligation that a change to §A must move §D and §C in the same edit.
Round 24 changed WHEN standalone audit rows are refused — from 4d-iii to 4d-i —
in the contract and in the inventory, and left P31's sentence saying "REFUSED
after 4d-iii … admitted before it". The new arms were APPENDED to that
paragraph, so the old expectation and its replacement sat two lines apart, which
is the companion document's round-4 finding 3 defect (a superseded sentence left
standing beside its replacement) reaching the proof table. An implementation
following P31 would have kept the forgery window open or written a suite that
contradicts its own contract.

That is worth stating plainly: **the round that minted the three-site rule broke
it in the round that followed, on the site the rule exists to protect.** The
obligation is not wrong, but "touch §C" is not the same as "re-read §C and
delete what the change falsified" — appending an arm is the easy half. So the
obligation gains its second clause: **when an edit changes WHEN or WHETHER
something is refused, the probe's existing sentences are re-read and the
falsified ones deleted, not left beside the new ones.** The same edit also
corrects the round-24 arms' RED baseline, which named round 21's map and not
round 23's unrestricted pair table — the thing those arms actually go red
against at 4d-i.

| finding | §A (contract) | §D (installer) | §C (proof) |
|---|---|---|---|
| 1 | both halves taken in the database, by the seals | `DomainEvent_t4d_deliveries` takes SHARE at the head of its deferred body, beside the INSERT trigger round 25 named | P38's event-vs-registration arm now covers the DIRECT writer, not only the emitter path |
| 2 | unchanged — round 24's contract was already right | unchanged — round 24's inventory was already right | P31's superseded sentence DELETED and replaced with refusal from 4d-i; the RED baseline corrected to name round 23's pair table |

### Review round 25 (head `3fee6bc4`) — eight findings, and FIVE are my own rounds 22–24 landing in §A and not §D

| # | classification | why that class |
|---|---|---|
| 1 (P2) | **unfixed recurrence** | the companion's round 4 put `requestToken` under the whitespace discipline and CLAIMED P-A7; P-A7 exercises `reason` and `actorId` only |
| 2 (P2) | **regression introduced by a fix** | round 22 moved `phase_plan` onto this plan in the Now block; a staging paragraph still instructs a handoff to keep it on the completed 4c plan |
| 3 (P1) | **genuinely new** | 4d-ii stamps `eventId`/`kind` while a 4c replica still serves the stored `text`/`color` cache, which nothing freezes |
| 4 (P1) | **regression introduced by a fix** | round 23 made Part 1 marker-aware and left `RolloutRetirement`'s creation in Part 3 — a fresh install queries a relation that does not exist |
| 5 (P2) | **regression introduced by a fix** | round 23 added the marker's own no-TRUNCATE seal and did not re-derive the closed seventeen-entry registry that is supposed to know every seal |
| 6 (P1) | **regression introduced by a fix** | round 24 corrected §A on rule initialization and left §D saying `syncConsumerCatalog` never writes rules |
| 7 (P1) | **regression introduced by a fix** | round 24's registration barrier names an advisory key and no installer; §D inventories only the delivery seals |
| 8 (P1) | **unfixed recurrence** | the window rule is stated generally and re-pointed two pair checks; the clause EVERY fact's pair check reads still judges `pmc` from the fanned-out register |

All eight reproduced before acceptance; none declined, none duplicate. The count
was reconciled against the review itself before this fold — eight comments,
eight answers — which is the check round 24 finding 7 produced after one was
dropped.

**The root cause is mine and it is one thing: I changed the CONTRACT and not the
INVENTORY.** Findings 2, 4, 5, 6 and 7 are all rounds 22–24's own corrections,
and four of the five have the same shape — §A gained the rule, §D kept the old
one, and §D is the list an implementation follows. Round 24's commit message
asserted that "contract, inventory and proof move together"; for findings 6 and
7 that was not true when I wrote it. The plan's oldest recorded root cause — *a
contract that names no installer is not installed* — was committed twice more by
the very edits that were fixing other instances of it, and finding 7 is the
purest form: an advisory key with no trigger to take it.

So the discipline stops being a sentence and becomes a per-edit obligation, in
the same form the marker-aware sweep took in round 23: **an edit that adds or
changes a mechanism in §A is not finished until it has named the STAGE and the
STATEMENT that installs it in §D and the ARM that proves it in §C, in that same
edit — and the round's own record says which of the three each fix touched.**
The table above is the first application; every fix below lists its three sites.

| finding | §A (contract) | §D (installer) | §C (proof) |
|---|---|---|---|
| 1 | the token's whitespace discipline, already there | — (no new statement) | P-A7 gains the token, mutation-tested independently |
| 2 | — | the staging paragraph now describes the committed Now block | the Now-block invariants, unchanged and already executable |
| 3 | `text`/`color` join the kinded-row freeze | 4d-ii's freeze arm | P32 gains both rewrites refused, and both admitted on a kind-less row |
| 4 | — | **Part 0**, a permanent marker transaction before Part 1 | P28b's replay arm, which needs the marker to exist to be run at all |
| 5 | — | `TRUNCATE_SEALS` is EIGHTEEN, and the registry is separated from the reset's table list | the seal-coverage tripwire, which reads the registry |
| 6 | initialization vs verification, already corrected in round 24 | the 4d-ii checklist now carries BOTH halves | `syncConsumerCatalog`'s own drift refusal, and P-A11 |
| 7 | the barrier, already stated in round 24 | `OutboxConsumerCatalog_t4d_registration_barrier`, BEFORE INSERT | P38's event-vs-registration arm, which round 24 added |
| 8 | the pair-check clause carries the window exception inline | the same seals, re-pointed at 4d-iii as the other two are | P29b's window request, which the plan already promises COMMITS |

**Finding 8 is the one worth reading twice.** The window rule was minted in round
4, stated as a general prohibition, and used to re-point the approval and change
request pair checks. Obligation 3's clause — which every fact's pair check reads,
the consultation request's included — kept naming `ProjectUserStanding` alone. So
the rule existed, was correct, was cited, and was not applied at one of its own
sites; and the site it missed refuses a request the delivered service authorises
and the probe table promises will commit. A general rule left unapplied at one of
its sites is not a rule, which is why the exception now sits inline in the clause
instead of three sections above it.

**Finding 3 is the only genuinely new one, and it is a disclosure.** Through the
drain both releases serve; the 4c replica renders from the stored `text`/`color`
because it has no structured renderer. Freezing the binding and leaving the cache
writable means a forged cache is served by the old replica for the length of the
drain while every new reader sees the truth. The freeze covers all six columns on
a kinded row, and only on a kinded row.

### Review round 24 (head `b1742d48`) — SEVEN findings; ONE is round 23's own, three are the reunification doing its job, and one I dropped from my own count

| # | classification | why that class |
|---|---|---|
| 1 (P1) | **regression introduced by a fix** | round 23's pair table is right for 4d-iii and wrong for the WINDOW: it admits a `countersigned` row on an ordinary direct approve |
| 2 (P1) | **genuinely new** | 4d-ii's rule columns meet the DELIVERED runtime creator of catalog rows; nothing before this round asked what a row's birth writes |
| 3 (P2) | **missed related path** | P38's two-append arm predates the companion document's round-2 protocol change and kept the pre-protocol expectation |
| 4 (P1) | **unfixed recurrence** | round 12's own rule — enumerate the OPERATIONS, not the columns — unfixed on a seal added after it |
| 5 (P1) | **missed related path** | the obligation race was closed twice for ACTIVATION of an existing row and never asked of REGISTRATION of a new one |
| 6 (P1) | **missed related path** | the companion's round-4 finding 2 put its migration in `ALWAYS_EXECUTE`; this stage's activation branch was never re-asked under replay |
| 7 (P1) | **missed related path** | the closure arm was built out over four rounds and each one asked whether the columns were PRESENT, never whether their two values agree |

**Finding 7 was dropped from my own enumeration, and that is recorded here as
its own failure.** The gate reported SEVEN current-head findings; I answered
six, wrote "six findings" in this heading and "none is declined" beneath it, and
pushed. Nobody declined finding 7 — it was simply missing from a list I called
complete, which is the exact defect this ledger has now recorded four times
(round 23 finding 2; the companion's round 4 findings 1 and 3). The count was
available and authoritative in the gate's own comment and I did not reconcile
against it. So the check gains the counterpart to *a completeness claim is
re-run, not inherited*: **reconcile the answered set against the REPORTED COUNT
before pushing — from the gate's number, never from the notifications that
happened to arrive.**

Each was reproduced against the repository before acceptance; none is declined
and none is a duplicate. **Three of the six (2, 3 and 6) are cross-document
findings that could not have been raised while the activation material sat in a
separate PR** — they are the reunification of round 22 working as intended, and
they are the argument against the split rather than for it.

**Finding 1 — round 23's own.** The pair table is the FULL correspondence and
was installed as the WEAK one. In the 4d-i → 4d-iii window a direct no-chain
approval commits with status `approved` and a `decision.approved` event; the
table admits `countersigned` and `stranded_resolved` against exactly that pair,
the revision (not the audit row) is the event's pairing claimant, so a
receipt-backed bundle adds a forged `countersigned` row that commits and becomes
immutable — and 4d-iii's converse validates INSERTS, never rows already written.
The premise that closes it is the reservation doors' own: while
`Decision_t4d_awaiting_reserved` and `Decision_t4d_architect_reserved` stand and
4d-ii-a is DARK, no chain transition can occur, so the four 4d-only audit kinds
are unreachable and any row of those kinds in the window is by construction a
forgery. The weak body is the four pairs `decisions.service.ts` writes today;
everything else is refused until 4d-iii.

**Finding 2 — the delivered creator.** `syncConsumerCatalog`
(`registry.ts:212-236`) CREATES a missing catalog row from the compiled
contract, and the shipped suites use it to bring consumers into existence at
runtime — `outbox-scanner.test.ts:46` and six ad-hoc consumers registered inside
individual tests, whose `deliveryFor` is an inline lambda no migration could
have pre-registered. "The migration is the only writer" would break every one of
them and P-A11's suites besides. The correction says what the function already
does, one column family wider: a row's BIRTH takes its rule from the compiled
contract, in the same act and from the same source as `consumerKind` and
`catalogVersion`, so no drift can be introduced by it; the migration owns the
rule of a row that already EXISTS, which is the delivered `assertMatches`
discipline extended rather than a new rule.

**Finding 5 — the shape of the previous two fixes, one axis over.** #567's round
1 finding 3 and #561's round 2 finding 5 both closed the obligation race for
ACTIVATION, and locking every catalog row `FOR SHARE` answers that completely.
It answers nothing for a row INSERTED and committed inside the window: there was
nothing to lock, and PostgreSQL offers no predicate lock that would have covered
it. New consumers are created ACTIVE and are created at runtime by the delivered
code. So event authoring and catalog INSERT take one shared registration
barrier, SHARE for the reader and EXCLUSIVE for the inserter, ahead of the
per-row locks and inside the one canonical lock order.

**Finding 7 — four rounds asking the wrong half of the question.**
`ChangeRequest.status` and `resolution` are unconstrained text in the delivered
schema (`schema.prisma:2453`, `:2457`), and the closure arm — built out over
rounds 8, 12, 13 and 16 — required only that the closure SET be complete. So a
receipt-holding writer reproduces an entire valid reapproval bundle and stores
`status = 'resolved'` with `resolution = 'withdrawn'`: every arm passes, and the
row is immutable under the freeze while contradicting the transition, the event
and the audit row it exists to corroborate. The delivered writers use exactly
two pairs, so the arm admits exactly those two, with the legacy NULL allowance
kept explicit and narrow.

**Findings 4, 6 and 7, and what they have in common with 1.** All four are seals
or branches whose PREDICATE was written for the shape the author had in mind
rather than for every operation that can reach it: a binding arm conditional on
the column a forger simply omits; an activation branch conditional on a mirror
an operator may legitimately have flipped; a converse admitting kinds the stage
cannot legitimately produce; a closure arm counting columns instead of reading
what they say. The rule this plan minted in round 12 covers all four, and
finding 4 is that rule unfixed on a seal added after it — worth recording
plainly rather than filing as four unrelated fixes.

**Contract, inventory and proof move together.** CONTRACT: §A.3's weak-body
restriction, the birth-writes-its-rule statement, the operation-shaped notice
binding, the registration barrier and the marker-gated retirement activation.
INVENTORY: 4d-i's rule freeze is on UPDATE and not INSERT; 4d-ii's catalog-data
migration owns existing rules only; 4d-iii's activation is initial-run only.
PROOF: P31 keeps the pair table but drives it against the 4d-iii body and gains
the window arms — each 4d-only kind refused at 4d-i; P32 gains the NULL and the
mismatched `decisionId`; P33 gains both crossed status/resolution pairs beside
the two truthful ones; P38 gains the event-vs-registration barrier, the
operator-pair/direct-pair split, and the replay over a deliberately deactivated
consumer.

### Review round 23 (head `41a2f52b`) — two P1s, BOTH round 21's own fixes

| # | classification | why that class |
|---|---|---|
| 1 | **regression introduced by a fix** | round 21's finding 3 closed a loose converse by writing a kind → event-type FUNCTION; the correspondence table refutes it in four of eight entries, and it would refuse every chain transition at commit |
| 2 | **regression introduced by a fix** | round 21's finding 1 gave 4d-i a `CREATE` whose body 4d-iii replaces — the exact shape round 16's marker-aware rule quantifies over — without joining that set or re-deriving the sweep sentence that counted it |

**On the ordering**: this review ran against `41a2f52b`, the head BEFORE round
22's reunification commit, and arrived after it. Nothing round 22 changed
touches the correspondence seal, so both findings apply unaltered to the current
head; they are numbered 23 because 22 is already taken by a scope instruction
that was not a review round.

Both reproduced against the repository before acceptance; neither is a duplicate
and neither is declined. Round 21 fixed two defects in this one seal and
introduced two more, which makes the audit converse the third mechanism in this
plan to produce a finding in three consecutive rounds.

**Finding 1, traced.** PRODUCERS of an audit row: the five service paths the
correspondence table enumerates. CONSUMERS of the rule: the deferred trigger
alone. ENFORCEMENT POINT: `DecisionEvent_t4d_correspondence`'s weak body, at
commit. STAGES: 4d-i installs it, 4d-ii-a is the first stage whose server writes
chain transitions, 4d-iii replaces the body. The table at §A.3 says a provisional
approve writes `approved`/`reapproved` beside `decision.awaiting_countersign` and
NO `decision.approved`; a countersign writes `countersigned` beside
`decision.approved`/`decision.reapproved`; a `stranded_resolved` accompanies
`decision.approved`/`reapproved` on the `completed` outcome and
`decision.change_requested` on the `returned` one. Round 21's map demands
`decision.approved` for the first, a `decision.countersigned` for the second —
a type `packages/shared/src/platform/events.ts` does not define and 4d does not
add — and "the stranded resolution's own event" for the third, which does not
exist. A kind → type FUNCTION cannot be right here: one kind appears under two
event types and one event type under three kinds. What the deferred arm can
actually read at commit is the audit row, the decision's COMMITTED `status` and
the transaction's events, so the arm is keyed on the PAIR, and §A.3 now carries
that pair table closed — any pair not in it refused. The window is checked
against the delivered writers rather than assumed: all four shapes the running
release writes appear in it, `withdrawChange` included, whose `updateMany` sets
`status: 'approved'` at `decisions.service.ts:911-913`.

**Finding 2, traced.** PRODUCER of the hazard: `ALWAYS_EXECUTE`, which re-runs
4d-i's raw SQL on a P3005 baseline of a mature database. CONSUMER: whatever body
the live trigger ends up carrying. ENFORCEMENT POINT: the `RolloutRetirement`
marker, which 4d-i already reads for the reservation doors and for the
consultation seal. STAGE: the gap between a replayed 4d-i and 4d-iii's own
replace — not instantaneous, and unbounded if the deploy stalls there. Round
16's sweep found "exactly one other statement of this shape … and no others",
and that sentence was TRUE when it ran and FALSE five rounds later, because
round 21 added a statement of exactly that shape and did not re-run the count.
So the seal joins the marker-aware set, and the sweep is replaced by an
OBLIGATION — a statement added to 4d-i's permanent portion whose body a later
unit replaces joins the set in the same edit, with the enumeration re-derived
there. *A completeness claim is re-run, not inherited*: this plan family has now
recorded that three times, here and in the companion document's round 4 findings
1 and 3.

**Contract, inventory and proof move together, and tracing the installers found
a third gap.** The CONTRACT is §A.3's pair table and the marker-aware
obligation. The INVENTORY is where this went wrong before: following the
trigger to the stage that installs it showed that 4d-i's staged list — the one
an implementation follows — named `DecisionEvent_t4d_append_only` and never
gained the `CREATE` for the correspondence trigger at all, five rounds after
round 21 introduced it in §A and named it only in 4d-iii's REPLACE. That is *a
contract that names no installer is not installed*, on this plan's own material
for the fourth time, and it is fixed in this edit rather than left for the round
that would have found it. The seal is also added to the reset protocol's name
list, where §A.3's "the seed learns ONE new name" was owed and unpaid. The PROOF
is P31, which gains the pair table driven row by row from 4d-i — each row RED
against round 21's map — plus the two pair-mismatch refusals that keep round
21's own point; and P28b's replay arm, which gains the audit row admitted by a
downgraded weak seal and refused by the marker-aware one.

### Round 22 — not a review round: the four-unit split is REVERSED, on instruction

JagPat: *"close #580 and take the whole 4d plan back to one unit."* This is a
scope instruction, not a finding, so there is nothing to classify as a
recurrence or a regression. What it changes, and what it must not lose, is
traced the same way a finding is.

**What moved.** `docs/superpowers/plans/2026-09-09-outbox-consumer-activation.md`
— the activation register, its seals, its baseline backfill, the mirror's sole
writer, the `outbox:consumer` operator protocol, its probes P-A1..P-A11, its
delivered-fixture inventory and its OWN findings ledger for rounds 1–4 — is
taken from the head that was reviewed as #580 (`4090b5b3`) and lands in this
unit's commit. **Every round, every finding and every answer is carried
verbatim.** Exactly two things in it were edited, and both because leaving them
would have made the file assert something false about where it now lives: a
header note saying that its "unit 1 of four, lands first" language describes the
interval when it was reviewed separately, and its `## Review unit` section,
which named a base SHA, a scope and a split that belong to a PR that is closing
— its two finding-bearing lines are kept inside it, marked as what they were.
Nothing in the specification, the probes or the ledger was touched. #580 is
closed pointing at the absorbing commit; no finding exists only inside a closed
PR.

**#580's four rounds, indexed here so this ledger names them.** The answers live
in the companion document, beside the material they corrected; this is the
index, not a second copy.

| round | head | findings | what it produced |
|---|---|---|---|
| 1 | `733c4b92` | ten, folded in ONE batch after the whole protocol was walked | the rule that an invariant is enforced at the OPERATIONS that can violate it, not at one writer's rows: the catalog-INSERT baseline trigger, the FK with its STRICT `NOT FOUND` raise, the mirror-write seam, the operator identity, and the first cut of the token |
| 2 | `feea630d` | four, **all four round 1's own** | `phase_plan` corrected off the completed 4c plan; the retry-identity CHECK widened to every retry-capable `actorKind`; P-A5 restaged as a pre-lock rendezvous; and the fourth question added to this family's check — *can the PROBE execute against the correct implementation?* |
| 3 | `f586a64e` | three | the parent cascade retired in favour of a sanctioned seam; the retry identity made `(consumer, actorKind, requestToken)` with a reserved `sys:` prefix; five delivered fixtures moved onto the supported operator path |
| 4 | `15e58c59` | six, **three round 3's own** | the eleventh catalog deleter found by search rather than recollection; `ALWAYS_EXECUTE` membership; ONE token uniqueness instead of two; and `sanctionedConsumerRemoval` specified, because `sanctionedReset` TRUNCATEs and cannot do row-scoped cleanup — a delivered helper named without being read |

Round 2's finding 1 is discharged AGAIN by this change, on this branch: STATUS
here carried the same defect it named — `phase_plan` pointing at
`2026-08-29-decision-workflow-4c.md`, a completed plan — and it now names this
one.

| affected surface | before | after |
|---|---|---|
| PRODUCER of the register | #580's own plan document | this unit's companion document, same content |
| CONSUMER — §A's obligation set | "the ACTIVE set that the OTHER unit defines" | the ACTIVE set that this unit's companion document defines |
| CONSUMER — §D 4d-ii's inventory | the three items are "NOT this unit's" | the three items are specified in the companion document, not restated in the list |
| CONSUMER — `decisions.effects`'s head | the prerequisite's catalog-INSERT trigger | the same trigger, installed by 4d-i of THIS unit |
| ENFORCEMENT POINT — merge order | `blocking_directive: phase-6-4d-unit1-prerequisite` in `docs/STATUS.md` | **removed**: one unit cannot land half of itself |
| ENFORCEMENT POINT — install order | prose plus that directive | migration order inside one unit: 4d-i installs, 4d-ii registers, 4d-iii activates |
| DEPLOYMENT STAGES | unchanged | unchanged — 4d-i/ii/iii keep their contents and their order |
| `docs/STATUS.md` `phase_plan` | `2026-08-29-decision-workflow-4c.md` (a COMPLETED plan) | `2026-09-07-decision-workflow-4d.md`, this plan |

**The directive removal is checked by execution, not by argument.** With the
directive present, `assessRunnerState` returned
`directive:phase-6-4d-unit1-prerequisite` and the post-merge simulation returned
the same — that was round 18's evidence. With it removed and `phase_plan`
corrected, both were re-run on this tree against
`scripts/autonomous-status-state.mjs` rather than reasoned about:

```
live   : {"actionable":true,"nextStep":"pr:572","reason":"an open PR is the current work item until it merges or closes"}
merged : {"allowed":true,"detail":null,"nextStep":"task:4","simulated":true}
```

`pr:572` is right while this unit is open — the PR IS the work item — and
`task:4` is right after it merges, because on that `main` the activation
document is present and 4d-i has everything it registers a consumer into. The hazard round 18 closed was a directive
that would be MISSING at merge time; the hazard it created — a directive naming
a satisfied or non-existent prerequisite, parking the runner — is the one that
would be live now, since the prerequisite is no longer a work item anyone can
pick up. Removing the key is what makes the state true, and the two rounds'
sections above carry a SUPERSEDED banner rather than being deleted, because the
defect each named (a contract naming no installer; a rule left in prose) is
still a rule this plan holds.

**Review size is now the whole unit again**, and that is the cost the split was
taken to avoid. It is stated rather than hidden: the marker trio in the PR body
carries the real figure, and the split's rationale paragraph below is rewritten
to say what became of it instead of continuing to advertise a four-unit plan
that no longer exists.

### Review round 21 (head `776b362e`) — three P1s, two of them round 20's own weak arm

| # | classification | why that class |
|---|---|---|
| 1 | **regression introduced by a fix** | round 20 put the weak converse on the IMMEDIATE trigger, re-committing the outage round 15's finding 2 had already diagnosed |
| 2 | **genuinely new** | the forward door gates on status and never on publication, and an unpublished draft is `status = 'pending'` |
| 3 | **regression introduced by a fix** | round 20's weak arm asked for "some event naming the decision", which any event satisfies |

None duplicate, none incorrect.

**Findings 1 and 3 are the same edit failing twice, and finding 1 is the worse
of the two.** Round 20 cited `decisions.service.ts:534`/`:546`, `:863`/`:865`
and `:924`/`:926` as proof that the running release satisfies a weak converse —
and those line numbers say the audit row is written BEFORE the event, which is
precisely why an IMMEDIATE arm cannot see it. The evidence quoted in support of
the placement refutes the placement. Round 15 had already established the
split — immediate for what must be immediate, deferred for what needs the
finished transaction — and round 20 moved a new arm onto the wrong side of it
without re-deriving the timing, four rounds after the rule was written down.

Finding 3 is the other half: "weak" was allowed to mean "loose". A converse that
asks for the existence of any event, rather than the RIGHT event, admits an
`approved` row beside a `decision.published` and makes it immutable. The weak
arm is now a kind-to-event-type map; it is weaker than the full converse only in
omitting the FACT and the TRANSITION, not in what it accepts as a companion.

**Finding 2 is the round's real new ground.** The forward door asks which STATE
a decision is in and never whether it was PUBLISHED, and an unpublished draft is
`status = 'pending'` — created that way at `decisions.service.ts:194`, stamped
`publishedAt` only at `:213`. So a PMC could forward a draft: the holder
mutation, an IMMUTABLE `DecisionForward`, the event, the notice and the push all
commit, and the target cannot see the decision at all, because
`decisionVisibleToViewer` keeps a draft private to its author. The delivered code
draws this line one command over — `assertConsultationEligible` refuses
`publishedAt === null` at `:58` — and the forward door is the sibling that did
not. Publication is now required at the command and at both DB doors.

### Review round 20 (head `a69b0671`) — two P1s: one declined on its mechanism, one accepted and closed earlier than planned

| # | classification | why that class |
|---|---|---|
| 1 | **incorrect finding — the rule it asks for already exists** | it asks to "enforce one standing flip per project per transaction"; `Membership_t4d_architect_provenance` has admitted at most one since #566's round 1, and the scenario it describes is not a valid transaction |
| 2 | **missed related path** | round 13 stated the 4d-i → 4d-iii window and called the drain its closure, without asking what happens to rows written INSIDE it |

**Finding 1, declined with the evidence.** The described attack — two architect
activations for one project in one transaction, both events carrying
`activeCount = 2`, both classified non-crossings — requires a transaction the
plan already refuses: the deferred constraint trigger on `Membership` admits AT
MOST ONE standing-flipping write per membership AND per PROJECT per transaction,
so the second write is refused at commit and no pair of events is ever produced.
The `activeCount` equality is exact for exactly that reason. What the finding
found is a WEAKNESS OF CITATION, not of design, and that is folded: the
parenthetical asserted the property and named no enforcer, so a reader looking
for one found the assertion instead — the same shape as round 19's "does nothing
else". It now names the seal. **And the probe gap is real**: P29b covers two
architects removed in one STATEMENT and not two flips across two statements in
one transaction, so that interleaving joins it — a rule with no probe is the
question this plan keeps having to answer.

**Finding 2, accepted, and it closes the window earlier than round 13 planned.**
Round 13 wrote that "the fabrication path stays open until 4d-iii … and the
drain is what closes it". The drain closes it for future writes; a row planted
during the window is made PERMANENT by this trigger's own UPDATE and DELETE arms
and is counted forever by `priorApprovals`, and a deferred trigger installed at
4d-iii validates nothing already present. The deferral's justification turned
out to cover only part of the rule: the previous release lacks the 4d envelope
pair and the 4d facts, but it DOES emit its event in the same transaction as its
audit row, at `decisions.service.ts:534`/`:546`, `:863`/`:865` and
`:924`/`:926` — read, not assumed. So 4d-i installs the WEAK arm (a
same-transaction `DomainEvent` naming the decision) across all eight kinds,
which the running release satisfies as written and a standalone plant cannot,
and 4d-iii TIGHTENS the same trigger rather than introducing it.

**The bound is stated rather than implied**: rows written BEFORE 4d-i predate
every seal, are the legacy class this plan already treats as unprovable, and no
trigger installed afterwards can validate them. This unit closes the window it
opens; it does not claim to close the one it inherited.

### Review round 19 (head `afd236a4`) — one P1, DECLINED on its mechanism and folded on what its trace exposed

| # | classification | why that class |
|---|---|---|
| 1 | **incorrect finding — with a real residue its trace exposed** | the fabricated DEMAND it describes is refused, by predicates specified since #558's round 1 and connected to the claimant by round 4's finding 5. But a lone forged audit row with NO demand is not, and that is a genuine gap |

**The declined half, with the evidence.** The finding reasons that because the
4d-i claim arm "does nothing else" and the 4d-iii converse enumerates seven
kinds excluding `countersign_renotified`, a writer can insert a
`decision.awaiting_countersign` plus the audit row and have the demand commit
and be delivered. It cannot. The verification for this branch is not on the
audit row at all — it is the ENTRY SEAL'S CONVERSE on the demand event, which is
DEFERRED and judges the finished transaction against: `renotified`,
`crossingEventId` and `transitionId` in the payload; `platform_event` proving a
committed `membership.standing_changed` of this project, naming that transition,
at an EARLIER position, and being the 0 → 1 activation rather than a 1 → 2;
`platform_latest_event` proving the decision's latest demand sits at or before
that crossing; exactly one same-transaction audit row naming the same crossing
and transition; a partial UNIQUE index on `(decisionId, crossingEventId)`; and
the push-shape check with a sorted, distinct audience equal to the active
architects at commit. Those are #558 round 1 finding 1, #558 round 2 finding 1,
#560 round 2 finding 3, #562 round 1 finding 6 and #565 round 1 finding 3 — five
rounds of exactly this attack. The forged bundle fails them, and it fails them
whether or not the claim was made, because a deferred constraint trigger does
not care which other trigger already ran. **No code is added for the described
defect**, per JagPat's instruction to answer an incorrect finding with evidence.

**What the finding got right is the WORDING, and that is folded.** "It claims
for `countersign_renotified` and does nothing else" reads, in isolation, as
though nothing verifies — which is how it was read. The claim arm now says where
verification lives and why the claimant is not the verifier here.

**And the trace exposed a narrower gap the finding did not describe, which IS
fixed.** The entry seal's converse fires on the DEMAND. It therefore judges
every forged demand and nothing that arrives WITHOUT one. A lone
`countersign_renotified` audit row — no `decision.awaiting_countersign` beside
it — records a re-notification that never happened into an append-only register
P29b reads as evidence of the crossing; the event-side converse has no event to
fire on, and the partial UNIQUE index forbids only a second row per (decision,
crossing), never a first. So `countersign_renotified` joins the 4d-iii
enumeration as the eighth kind, requiring its demand, its crossing and its
transition in the same transaction. That is the same rule the other seven carry,
applied to the kind that was left out of it because it already had a claimer —
which is what made it look verified.

### Review round 18 (head `b7e6610e`) — one P1: my own round-17 answer was prose

> **SUPERSEDED BY ROUND 22.** This round's correction — the
> `blocking_directive` in `docs/STATUS.md` — guarded a merge order between two
> PRs. The split it guarded was reversed and the directive is removed; the
> record of the finding and of the answer stays, because the DEFECT it named (a
> contract naming no installer) is a rule this plan still holds.

| # | classification | why that class |
|---|---|---|
| 1 | **unfixed recurrence** | round 17's finding, unclosed: the correction was a promise about a future change rather than a change, and this commit still records `blocking_directive: none` |

Correct, and conceded without qualification. Round 17 answered a merge-ordering
hazard with a post-merge obligation and no installer — the same defect this plan
named as ROOT CAUSE ONE in round 14 and then committed twice more. A rule that
executes at merge time must exist in the file before the merge; there is no hook
in `assessPostMergeRunnerState` that could write it, and I did not check whether
one existed before promising it.

**The trace, run rather than argued.** ENFORCEMENT POINT:
`assessRunnerState`, reading `blocking_directive`. STAGES: with the directive
absent, the post-merge simulation for this PR returned `task:4`; with it
present, it returns `directive:phase-6-4d-unit1-prerequisite`. Both were
executed against `scripts/autonomous-status-state.mjs` on this working tree, not
reasoned about. CONSUMERS: the runner's next-step resolution only — the
exact-head gate and the correction owner do not read the key, which is what
makes round 17's "it would park the review loop" objection weaker than the
hazard it was weighed against.

**And the correction creates a mirror hazard, which is closed in the same
edit**: a directive naming a prerequisite that has since landed would park the
runner on finished work. So STATUS carries the directive's COMPLETION TEST — the
activation plan present on `main` — and the merge-order resolution rule, since
#580's STATUS entry and this one touch the same keys and whichever merges second
resolves them. The resolved state must be true at that moment: the directive
stands iff the file is absent.

### Review round 17 (head `e264fb47`) — one P1: the split's own ordering, unenforced

> **SUPERSEDED BY ROUND 22**, with round 18. The ordering hazard was between
> two PRs; there is now one unit and one commit, so the hazard has no state to
> occur in. The dependency itself survives as migration order inside the unit.

| # | classification | why that class |
|---|---|---|
| 1 | **missed related path** | round 14's finding 5 made this plan CITE #580's catalog-INSERT trigger and never asked what happens if this plan merges FIRST |

Not a duplicate and not incorrect: the tree search is right — this head carries
no `2026-09-09-outbox-consumer-activation.md`, because that document is #580's.

**The trace.** PRODUCER of the dependency: §D 4d-ii's `decisions.effects`
registration, which needs the catalog-INSERT trigger for its head. CONSUMERS:
4d-iii's activation append and its head verification, and the operator no-op
branch that must have a head to return. ENFORCEMENT POINT: none existed — the
order was prose, and prose does not survive a merge. DEPLOYMENT STAGES: the
natural order is safe by construction, since #580 depends on nothing here; the
INVERTED order is the whole risk, and it is reachable because merging is the
Board's. Walked through the delivered resolver: this plan merging first clears
`open_pr` in `assessPostMergeRunnerState`, leaves `task_state: in_progress`, and
`assessRunnerState` returns `task:4` — the runner starts 4d-i with the register
absent from `main`.

**Contract, inventory and proof move together**: 4d-i gains the precondition
(the activation unit on `main`, checkable as a file rather than as a PR number),
the 4d-ii registration line carries it where the dependency is cited, and the
post-merge obligation names `blocking_directive:
phase-6-4d-unit1-prerequisite` — verifiable against
`scripts/autonomous-status-state.mjs`, whose directive branch returns before the
`open_pr` branch.

**And one instrument is deliberately NOT used now, with the evidence for why.**
Setting that directive today would be wrong: on an `in_progress` task the
directive outranks `open_pr`, so it would redirect the runner away from this PR
— the open work item currently under correction — and park its review loop
behind a directive nobody is working. The same key is right after a merge and
wrong before one, which is why it is written as a post-merge obligation. The
finding's OTHER remedy — "land the prerequisite before this commit" — is not
available to any session: merging and deploying are the Board's, and this
session does not merge.

### Review round 16 (head `3a3dd090`) — three P1s, classified and traced before correction

JagPat directed that every finding be CLASSIFIED before another correction push,
that each accepted one be traced through every producer, consumer, enforcement
point and deployment stage, that contract, implementation inventory and
behavioural proof move together, and that a duplicate or incorrect finding get
an evidence-backed answer rather than more code. This round is the first worked
that way.

| # | classification | why that class |
|---|---|---|
| 1 | **regression introduced by a fix** | round 13's finding 1 refused the row born CLOSED and said nothing about what an OPEN row may carry, so the closure provenance became forgeable one step earlier |
| 2 | **missed related path** | the replay question was asked of 4d-i's reservation DOORS (marker-aware) and never of the `CREATE OR REPLACE` statements beside them, whose bodies a later unit replaces |
| 3 | **regression introduced by a fix** | round 15's finding 3 moved two of the cycle's sites and called the rule discharged |

No finding this round was a duplicate, and none was incorrect: each was
reproduced against the delivered code before it was accepted — the resolver
columns' schema defaults for 1, the `RolloutRetirement` marker's own placement
for 2, and the five counting sites plus `viewerIsConsultee` for 3. **One
finding's literal instruction WAS wrong and is answered rather than followed**:
finding 3 asks that "every cycle producer and reader" be converted, and two
revision counts in the same service must not move —
`decisions.service.ts:1147`, which refuses withdrawal of a decision carrying
approval evidence (a provisional approval IS evidence, and converting it would
make a decision awaiting countersign withdrawable), and `:511`'s
`priorApprovals`, which counts `DecisionEvent` rows to allocate the next version
and is not a cycle count at all. Both are now named in the trace so the sweep
cannot be "finished" by breaking them.

**The traces** are carried where the rules are, not here: finding 1's producers
(`requestChange`, the `returned` bundle, the seed plant) and their compliance
with the empty-closure-set rule sit in §D 4d-iii; finding 2's deployment stages
(fresh, upgrade, P3005 replay over a retired database, partial-deploy recovery)
and the one-other-statement sweep sit in §D 4d-i; finding 3's nine-site
producer/consumer/enforcement table sits in §A.2 beside the cycle rule, with the
4d-ii inventory line naming the same sites and P25d proving them.

Contract, inventory and proof were edited together for all three, which is the
specific discipline the previous four rounds lacked: rounds 13, 14 and 15
produced seven findings between them whose entire content was that §A had moved
and §D had not.

### Review round 15 (head `8582992f`) — three P1s; two are round 14's OWN two root causes, one round later

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) §A makes `platform_user_orchestration_authority` depend on the new `ProjectOrg` register and §D's closed 4d-i inventory never creates, feeds, backfills or seals it — nor lists its no-TRUNCATE entry — so the staged build reaches the 4d-iii switch with the derivation's source absent and every membership-less PMC action failing | §D 4d-i; `TRUNCATE_SEALS` | the register lands in the inventory in FULL — table, primitive, `Project` trigger, backfill, writer-depth seal, cascade arm, immutable `orgId`, `platform:verify`, and the SEVENTEENTH truncate seal |
| 2 (P1) the audit converse was written into the IMMEDIATE `DecisionEvent_t4d_append_only`, but the delivered writers insert the audit row BEFORE they emit (`decisions.service.ts:534`, `:863`, `:924`), so its INSERT arm looks for an event the transaction has not written and rejects every approval, change request and withdrawal after 4d-iii | §A.3 obligation 7; §D 4d-iii; P31 | a SEPARATE DEFERRED constraint trigger, `DecisionEvent_t4d_correspondence`, judged at commit — the same split round 4's finding 1 made for `Notification_t4d_binding`. The immediate trigger keeps the UPDATE/DELETE freeze and the 4d-i pairing claim, which cannot be deferred. The seed learns one new name |
| 3 (P1) the consultation cycle is a revision COUNT, and 4d breaks it in both directions: a consultation requested while awaiting survives the countersign (which appends no revision) and is answerable again after a `requestChange` reopen; one requested while `pending` dies the moment the provisional revision is inserted, though the open set now includes `awaiting_countersign` and its push is deliberately left uncancelled | §A.2 (the cycle); P25d | the cycle counts FINALIZED approvals, at both the freeze (`:638`) and the comparison (`:765`). Legacy needs no migration — the backfill leaves every pre-4d revision `finalized = true`, so the two counts agree on every decision that predates the chain |

**Findings 1 and 2 are round 14's own two root causes, committed on round 14's
own fixes.** Root cause one was *a contract that names no installer is not
installed* — and the `ProjectOrg` register, added in that very round to fix
finding 1, went into §A and not into §D. Root cause two was *a contract that
cannot be executed is not a contract* — and the audit converse, corrected in
round 13 and carried into §D by round 14, cannot execute against the delivered
writers, which insert before they emit. Writing the rule and applying it to the
material in the same batch are different acts, and this round is the evidence
that the second does not follow from the first.

So the three questions become a CHECKLIST DISCHARGED PER CORRECTION, not a
principle stated once at the end of a round. For every arm this plan adds or
changes, in the same edit that changes it:

> 1. the §D unit line that installs it — quoted, not assumed;
> 2. every value it reads, with the register or column each comes from, and
>    whether that source exists in the SAME unit or earlier;
> 3. the delivered writers it must admit, named with file and line, and the
>    ORDER in which they write — because a correspondence arm judged at the
>    wrong instant refuses the writer it was built to protect;
> 4. and, for anything with a probe, whether the probe can execute against the
>    correct implementation (the activation document's own round 2, finding 3,
>    raised while it was reviewed separately as #580).

Finding 3 is the round's only NEW-DOMAIN finding, and it is the more valuable
one: it is not a sweep, it is a real behavioural consequence of introducing a
revision that approves nothing and an approval that appends no revision. The
paragraph it corrects claimed the cycle semantics "need no new rule" and
reasoned only up to the countersign, never past it.

### Review round 14 (head `1722764c`) — seven findings, and TWO root causes, one of them round 13's own

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) the race-free derivation cannot be IMPLEMENTED by a decisions-owned seal: `OrgUserAuthority` is keyed by `orgId`, the seal holds only `projectId`, and no register carried the mapping — so every decisions-owned arm taking that derivation either reads an orgs table (forbidden) or skips the join and accepts an owner of an UNRELATED org | §A.2 the race-free registers; §D 4d-i; P29b | `ProjectOrg(projectId, orgId)`, platform-owned, written by the `Project` trigger from its own row — race-free for the same reason `OrgUserAuthority` is. The join happens inside the kernel; no decisions seal reaches an orgs table. `orgId` immutable, cascade arm, no-TRUNCATE seal. P29b gains the cross-org stranger, REFUSED |
| 2 (P2) the 4d-ii inventory still restates the activation register, its mirror and `outbox:consumer`, which the activation document specifies | §D 4d-ii | only 4d's consumer REGISTRATION and delivery changes stay in that list; the companion document holds the rest, and the implementation of this list reads the ACTIVE set it defines |
| 3 (P1) the `countersign_renotified` audit row is the pairing CLAIMANT for a pairing-required `decision.awaiting_countersign`, but there was no INSERT trigger on `DecisionEvent` at all — so nothing could call `platform_claim_event_pairing` and every legitimate re-notification would abort as unclaimed | §A.3 obligation 7 (the audit row); §D 4d-i; P29b | 4d-i installs the trigger as BEFORE **INSERT OR** UPDATE OR DELETE, its INSERT arm claiming for that one kind — by round 11's own rule, the claimant's seal belongs to the unit that makes the event pairing-required |
| 4 (P1) §A now promises the audit INSERT converse and the 4d-iii staged inventory installs only the `ChangeRequest` seal | §D 4d-iii | the inventory installs the widened arm with its hostile probes and the revision sequence asserted unmoved |
| 5 (P2) §A adds the notification INSERT converse and the 4d-ii inventory teaches writers only to POPULATE the columns | §D 4d-ii | the catalog-data migration extends `Notification_t4d_binding_bound` with the converse, with the late-insert probe |
| 6 (P1) the revision birth seal requires the recorded actor to HOLD the decision's holder designation, but the delivered `approve` lets a `pmc` approve on a client's or named member's behalf and records `onBehalfOf` — so 4d-i would reject an existing legitimate approval the legacy-writer table promises still commits | §A.3 (the revision's birth seal); §D 4d-i; P37 | the seal judges the PAIR `(actor, onBehalfOf)`, which is what the service judges. A NULL `onBehalfOf` still demands the holder; a forged one from a non-`pmc` is refused by the `pmc` half |
| 7 (P1) the 4d-ii inventory still sends `requestChange` to copy its frozen pair from the pre-transaction `resolveActor` read | §D 4d-ii | obligation 3's corrected contract, in full, on this writer too |
| 8 (P1) the approval revision's frozen pair is judged for CORRESPONDENCE and never for AUTHORITY: `phase6_t4d_actor_bound` proves the pair is true of `approvedById` and asks nothing about whether that actor holds the decision's designation, so an actor with a genuine `decisions.approve` receipt and a truthful pair can record an approval of a decision that is not theirs (#582's review round 19, finding 3) | §A.3 obligation 3; §D 4d-ii | the binding was written and MEASURED in 4d-i and backed out: wired there it produced **30 integration failures across ten files, every one this rule** (29 `client`, one `member`), which are delivered `decisions.approve` paths passing today — a dark migration may not refuse thirty currently-legal service writes. 4d-ii carries it, where the writer moves onto the register and seal and writer change together; the open question that unit must answer first is WHICH is wrong, the service's authority check or the standing the register holds for these actors |

**Root cause one: a contract that names no installer is not installed.**
Findings 2, 4, 5 and 7 are all the same, and it is round 13's own finding 4 —
which I fixed at the single line it named. §A states what a seal must do; §D
states what each unit installs; an implementer follows §D. A correction written
only into §A is a correction nobody performs, and four of this round's seven are
that. It has now happened on the notification converse, the audit converse, the
`requestChange` attribution and the activation ownership, in ONE round, from ONE
previous round's corrections.

**Root cause two: a contract that cannot be executed is not a contract.**
Findings 1, 3 and 6 are the other kind, and they are worse, because each reads
as a complete rule. Finding 1 names a register the seal cannot key into. Finding
3 names a claimant with no trigger to claim from. Finding 6 names an authority
narrower than the writer it must admit. Each was written where the rule is READ
and never checked against what would have to EXIST to run it, or against what
already runs today.

So the standing check, which is three questions asked of EVERY seal arm and not
of the one a finding names:

> 1. **Which unit installs this arm?** Name it in §D's inventory, or the arm
>    does not exist. A contract corrected in §A is not delivered until the
>    staged unit that installs it says so.
> 2. **What does it READ, and where does each value come from?** Every input
>    must be reachable from the arm's own module and its own keys. A predicate
>    over a register the seal cannot key into is not a strict rule, it is an
>    unimplementable one — and the tempting repair is to drop the join, which
>    silently widens the rule instead of narrowing it.
> 3. **Which DELIVERED writers must it still admit?** Name them and check the
>    shipped code. A seal that refuses a legitimate write that runs today is a
>    production incident with a review's blessing.

Rounds 9 through 14 have found the previous round's fix defective on
transaction, unit, domain, operation, direction — and now on INSTALLATION and
EXECUTABILITY. The first five were about what a rule says; these two are about
whether anything performs it and whether it can be performed at all, which is
why the check above is now three questions and is applied per arm.

### Review round 13 (head `f274d3dd`) — five findings; three are round 12's rule applied to ONE seal instead of its class

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) round 12's own INSERT arm ADMITS a `ChangeRequest` born `withdrawn` or `resolved` once the requester and closure sets are populated. No shipped command creates a closed request and the row never passed the sealed opening transition, so a receipt-holding writer manufactures permanent evidence of a request AND a closure that never occurred — and the closure arm stays silent, because the row never left `'open'`; it was never in it | §D 4d-iii (the INSERT arm); P42 | `status <> 'open'` on INSERT is REFUSED OUTRIGHT. Naming an operation is half the question; whether it is LEGAL is the other half |
| 2 (P1) `DecisionEvent_t4d_append_only` is BEFORE UPDATE OR DELETE, so a standalone `approved`/`reapproved` audit row inserted AFTER the approval transaction committed meets every seal — and `approve` allocates the next revision from `max(registerHead, priorApprovals) + 1` where `priorApprovals` COUNTS those rows, so the fabrication corrupts the revision sequence as well as the history | §A.3 obligation 7 (the audit row); §D 4d-iii; P31 | the SAME trigger gains its INSERT converse in 4d-iii: each listed audit kind requires its fact, its transition and its `DomainEvent` in the same transaction. Trailing, because the previous release writes these rows; the seed's plants join the bypass they already name |
| 3 (P2) a kinded `Notification` inserted for an already-committed event that owed none passes the binding seal, the FK, kind equality and the partial uniqueness — the transition's correspondence cannot object because that transaction is over — and the row is then UNDELETABLE by the same binding seal | §A.3 obligation 7 (the feed row); §D 4d-ii; P31 | 4d-ii's kinded arm gains the converse at INSERT: a non-NULL `eventId` is admitted only when THAT event is inserted in the same transaction, and the no-notice branches require ZERO rows. Kind-less rows untouched, so no trailing installation is needed |
| 4 (P2) §D's implementation inventory still says the commands write the frozen pair "from the actor's token" — the pre-transaction read round 12 corrected in §A.3 and did not sweep here | §D 4d-ii (the inventory) | the inventory carries obligation 3's corrected contract in full: the NAME under the identity lock inside `executeCommand.run`, the ROLE by the window disposition |
| 5 (P2) the activation baseline's backfill runs in 4d-i, before 4d-ii registers `decisions.effects`, so an answer resting on backfill ORDER leaves the newly registered consumer with no head | §D 4d-ii (the registration) | the head comes from the catalog-INSERT trigger — the activation document's own round-1 finding 4 — which appends every new catalog row's baseline whoever inserts it. This row registers and owes nothing further |

**Three of these are one root cause, and it is round 12's rule stopping at the
seal that produced it.** Round 12 concluded *enumerate the OPERATIONS, not the
columns*, and then discharged it on `ChangeRequest`'s closure arm alone. Asked of
the CLASS — every seal in this plan that judges a CORRESPONDENCE — the same
question has an obvious and uniform answer: each of those seals fires inside the
transaction that AUTHORS the pair, and a writer who arrives afterwards meets none
of them. The missing operation is always the same one: **the standalone INSERT of
one side, after the other side's transaction has committed.**

Walked, with each side's disposition and why:

| the side a late writer could plant | what refuses it | disposition |
|---|---|---|
| `DecisionEvent` audit row (the seven listed kinds) | nothing — the 4d-i seal is UPDATE + DELETE only | **finding 2, fixed here** |
| kinded `Notification` feed row | nothing — the binding seal freezes and refuses DELETE, and admits a late INSERT | **finding 3, fixed here** |
| `ChangeRequest` born closed | nothing — round 12's arm admitted it on obligations | **finding 1, fixed here** |
| `DomainEvent` | the envelope allocation seal (position = `nextPosition`, with the increment) and, for a pairing-required type, the kernel's same-transaction claim | covered |
| `DecisionForward`, `DecisionCountersign`, `DecisionStrandedResolution` | pairing-required INSERT seals, both directions | covered |
| `DecisionApprovalRevision` | its birth seal plus the deferred receipt binding to a SUCCEEDED command | covered |
| `MembershipTransition` | the fact-first protocol, the deferred `phase6_t4d_membership_transition_bound`, and the membership write's own BEFORE trigger | covered |

So the rule round 12 left is not replaced, it is finished:

> **A seal that judges a correspondence must have a CONVERSE.** Asking the fact
> for its audit row, its event and its notice constrains only the transaction
> that writes the fact. Every side of a pair needs the arm that asks IT for the
> rest — otherwise the side with no converse is the one a later writer plants,
> and an append-only seal makes the forgery permanent instead of the truth.

Rounds 9 through 13 have now found the previous round's fix defective on
transaction, unit, domain, operation, and now DIRECTION. Each is the same
question asked one step further out, and each was answerable from the previous
round's own rule — which is the argument for finishing the sweep at the class
rather than at the instance, and the reason this round's three corrections were
made together.

### Review round 12 (head `d443aa18`) — five findings; two EXTRACTED to the activation document, three folded here AFTER the audit

Not folded per finding when it arrived, because JagPat directed a change of
approach from per-finding correction to closing the underlying gaps, and this
round is the evidence for it: three of the five are this plan's OWN previous
fixes failing. The three that stayed here were HELD while the affected
behaviour was audited whole — every closure operation on `ChangeRequest`, every
reader of the per-user registers inside the drain window, and every 4d seal
that refuses a DELETE on a project-scoped table — and they are folded here in
ONE batch, together with what that audit found beside them.

| finding | disposition |
|---|---|
| 1 (P1) the closure UPDATE arm fires only when `resolvedById` goes NULL → non-NULL, so a writer sets `withdrawn` while LEAVING it NULL and never reaches round 11's origin prohibition — the invalid closure commits without provenance and strands the decision in `change` | FOLDED here (§A.2, §A.3 the `ChangeRequest` row, §D 4d-iii, P42/P33/P28b). The arm is re-keyed on the CLOSURE — `status` leaving `'open'` — not on the resolver column a hostile writer simply omits; with the two other operations the audit found on the same domain: `status` never returns to `'open'`, and a `ChangeRequest` row is not DELETED outside the sanctioned reset |
| 2 (P2) the baseline backfill covers pre-existing rows, but `decisions.effects` is registered after it and has no head | **EXTRACTED to the companion document**, fixed there (backfill runs last) |
| 3 (P1) resolving the WHOLE frozen pair from the registers breaks the window rule: a membership-less owner/admin has no fanned-out `pmc` row during 4d-i → 4d-iii, so a legitimate command cannot resolve its role | FOLDED here (§A.2 the window rule; §A.3 obligation 3; P29b). The pair is split by HALF: the NAME is read from `UserIdentity` under `FOR UPDATE` inside `executeCommand.run` (round 11's actual fix, kept); the ROLE takes §A.2's window disposition — the race-free derivation until 4d-iii re-points it — and the window rule is restated to bind WRITERS as well as seals, which is the generalization round 11 missed |
| 4 (P2) the state-only no-op undoes a later operator's intent after a lost response | **EXTRACTED to the companion document**, fixed there (stable request token) |
| 5 (P2) the `MembershipTransition` append-only seal has no project-cascade exception, so the claimed hard delete of an event-free project hits it | FOLDED here (§A.2 the membership paragraph; §D 4d-i; P29b). The seal gains the depth-and-flag cascade arm its sibling `Membership_t4d_architect_provenance` already carries, and the audit states the cascade disposition — with its proof — for EVERY 4d seal that refuses a DELETE on a project-scoped table |

**The AUDIT, and what it found beside the three findings.** Each finding was
treated as a symptom and its whole behaviour walked before anything was
written, which is what JagPat's instruction asked for and what the per-round
fold had stopped doing.

*The closure domain (finding 1).* A CLOSURE of a `ChangeRequest` is the row
leaving `status = 'open'`. The delivered writers are exactly two —
`decisions.service.ts:492` (the re-approval's `updateMany` to `resolved`) and
`:919` (`withdrawChange`'s to `withdrawn`) — and BOTH set `status`,
`resolution`, `resolvedById` and `resolvedAt` in one statement, which is why an
arm keyed on the resolver column looked equivalent to one keyed on the closure
and is not: the equivalence holds for the two writers that behave, and this
plan models a receipt-holding database-role writer that does not. Enumerating
the OPERATIONS over that domain rather than the columns yields three, not one:
**(a)** the UPDATE that closes — re-keyed on `status` leaving `'open'`, so the
complete set, the origin prohibition and the requester-or-PMC authority are all
reached by a writer that sets `status` and nothing else; **(b)** the UPDATE
that RE-OPENS — `status` returning to `'open'` is refused outright, without
which a closed row could be reopened and closed again with the resolver columns
already non-NULL, and the second closure would escape an arm keyed on either
column's transition; and **(c)** the DELETE — erasing an open request strands
its decision in `change` exactly as (a) does, and erasing a closed one destroys
the provenance the trailing seal exists to demand, so the row is not deleted
outside the sanctioned reset, by the same doctrine that already makes
`DecisionEvent` append-only and refuses `Notification_t4d_binding`'s DELETE.
The INSERT arm is widened by the same enumeration — and round 13, finding 1
then corrected the answer this round gave it: a row INSERTED already closed is
REFUSED outright, not admitted on obligations. Enumerating an operation is only
half the question; whether it is legal at all is the other half, and a request
born closed never passed the sealed opening transition, so admitting it with a
truthful closure set manufactures evidence of a request that never happened. **Nothing here
touches the shipped writers**, and that is checkable rather than asserted —
both write all four columns together today, so both satisfy an arm keyed on
`status`.

*The window's readers (finding 3).* §A.2's window rule was written as a rule
about SEALS — *"no seal a window writer can reach judges a user's `pmc`
standing through the fanned-out register"* — and round 11 put a WRITER on the
register instead, which the sentence does not literally forbid and the rule
plainly does. The register is not ready in the window; that binds everything
that reads it, not everything that judges with it. Walking the readers rather
than the seals: the four disposed arms are seals, the fifth is the frozen-pair
resolution round 11 added, and it is the first WRITER-side reader the plan has
— so the rule is restated to name both, and the §A.3 window-disposition column
is the place a sixth is caught without being listed.

*The DELETE sweep (finding 5).* The cascade question is owed by every 4d seal
that refuses a DELETE on a project-scoped table, and the answers differ only by
whether the table's rows can exist on a project that is hard-deletable at all —
`DomainEvent.tenant` is `onDelete: Restrict`, so only an EVENT-FREE project
ever reaches a cascade. `ProjectEventStream`, the `ProjectRoleStanding` writer
seal, the per-user registers and `Membership_t4d_architect_provenance` already
carry the depth-and-flag arm. `MembershipTransition` does not, and it is
reachable: the crossing EVENT is demanded only of writes that flip ARCHITECT
standing, so a receipt-backed non-architect transition leaves a fact on a
project with no `DomainEvent` — and the seal then refuses the very cascade its
own sibling on `Membership` explicitly admits. The rest are unreachable WITH A
PROOF, not by hope: every `DecisionEvent` write site in the repository emits a
`DomainEvent` in the same transaction (the writer sweep this plan already
pins), and `DecisionForward`, `DecisionCountersign`, `DecisionStrandedResolution`
and every bound `Notification` are pairing-required with their events, so a
project holding any of them holds events and its hard delete is refused at the
tenant FK before a cascade runs. `ChangeRequest`'s new DELETE arm is in that
same class.

**The rule round 12 leaves, sharpening round 11's rather than adding a fourth:**

> **Enumerate the OPERATIONS, not the columns.** A seal is keyed on the
> operation the rule is about — the state transition that IS the act — never on
> a column a well-behaved writer happens to set alongside it. For every rule:
> which operations can perform the act it forbids (INSERT, UPDATE, the REVERSE
> update, DELETE, and the cascade), and does the arm fire on each of them? An
> arm keyed on a correlated column is enforced against the writers that already
> comply and against nobody else.

Rounds 9, 10, 11 and 12 have now each found the previous round's fix defective
on one axis — transaction, unit, domain, and now OPERATION. That progression is
the reason the remaining risk in this plan sits in the intermediate stages and
not in the final design, and it is why the delivery structure below splits the
units rather than shipping one document's worth of seals at once.

**The split, and what became of it.** For rounds 13–21 the activation register
was carried as a separate unit — PR #580, "unit 1 of four" — on the argument
that nothing depends on it and everything depends on it. Round 22 REVERSED that
split on JagPat's instruction: the activation document is a companion file of
THIS unit, `docs/superpowers/plans/2026-09-09-outbox-consumer-activation.md`,
and the two land in one commit. The dependency order it was meant to express is
unchanged and is now internal — 4d-i installs the register, 4d-ii registers
`decisions.effects` into it, 4d-iii activates after the drain — but it is
enforced by migration order inside one unit instead of by a merge order between
two PRs that no session controls. No finding was discarded in either direction:
every finding above keeps its round and its number, and #580's own rounds 1–4
arrive with the document that answered them.

### Review round 11 (head `3e2db742`) — three findings, and the claimant column has now produced two

| finding | where it lands | the answer |
|---|---|---|
| 1 (P1) round 9's claimant column gave `decision.change_withdrawn` to the UPDATE arm of `ChangeRequest_t4d_provenance_required`, which §D installs only in 4d-iii. That event is pairing-required from 4d-i, and BOTH the previous release and 4d-ii execute `withdrawChange` in the window between them — so the kernel sees no claim and rejects every withdrawal at commit; after 4d-iii the permanent seal and the trailing one would both claim and collide on the per-event UNIQUE | the §A.3 correspondence table (the column header + two rows) | the claimant is `ChangeRequest_t4d_paired`, the PERMANENT 4d-i pairing seal, with the trailing provenance trigger verification-only. The column header now carries the rule: the claiming seal must be installed by the unit that makes the event pairing-required, never a later one |
| 2 (P1) round 10 added the requester-or-PMC predicate for a `standard` request closed to `withdrawn` and asked nothing about the OTHER origin on the same transition. The closure/restoration pairing covers `standard` alone, so a receipt-backed direct writer could withdraw an open `countersign_rejection` request with a truthful resolver set, leaving its decision in `change` — a state the service forbids and cannot recover, since reapproval requires exactly one open request | §D 4d-iii (the closure UPDATE arm); P33 | `open → withdrawn` is refused by ORIGIN before any authority is judged: a rejection request's only legal closures are the `resolved` its reapproval writes and the `returned` resolution's bundle. P33 gains the hostile direct update with a PMC resolver and every provenance column correct |
| 3 (P2) obligation 3 argued that because the fact is written in the act's transaction, "at the act" and "at commit" are the same instant. `resolveActor` reads `User.name` BEFORE `executeCommand` opens that transaction, so a rename committing in between projects a new `UserIdentity` and the fact's trigger rolls back an authorized command against a stale frozen name | §A.3 obligation 3; P29b | the frozen pair is resolved INSIDE `executeCommand.run`, from the registers, with the identity row taken `FOR UPDATE` before the read. P29b gains the held-rename barrier in both resume orders |

**Findings 1 and 2 are round 9's and round 10's own fixes, and the claimant
column has now produced a finding in two consecutive rounds.** That column was
round 9's answer to a hand list, and it was the right answer — but a table
cell that names a FACT was never enough, because a claim is made by a SEAL,
and a seal exists only from the unit that installs it. Round 10 caught a cell
naming a fact a different TRANSACTION writes; round 11 catches one naming a
seal a different UNIT installs. Same column, same shape, one axis apart.

Finding 2 is the other recurring shape: a predicate added for the case a
finding named, over a set whose other members were never visited. Round 6
replaced a hand list of writers with a derivation for exactly this reason, and
round 10's own remedy then went in as a hand-scoped predicate — `standard`
only — without asking what the sibling origin does on that transition.

So round 11 sharpens round 10's question rather than adding a fourth:

> **Name the enforcer, its UNIT, and its whole domain.** For every rule:
> which operation breaches it, which seal judges that operation, WHICH UNIT
> installs that seal — and is it installed at every moment the rule must
> hold, including the compatibility window? And over which values of every
> discriminator the rule mentions? A predicate scoped to the one value a
> finding named is a hand list with a single entry.

**Walked.** Every claimant cell was re-checked for its seal's unit: the two
`ChangeRequest` rows named a trailing trigger and are corrected; the
membership row's `MembershipTransition` seal, the decisions fact seals and the
audit-row claimant are all 4d-i, and the events they claim become
pairing-required in the same unit. Every discriminator the closure arms
mention was enumerated: `origin` has exactly two values and both are now
stated on `open → withdrawn`; `outcome` has two and both are stated; the
`approvedFrom` pair was settled in round 9.

**Docs-only.** No schema, no migration, no runtime code, no test change, no
4d implementation. Contractor-capture units 1–6 and the saved UX and
performance work stay Board-gated and are not mixed in.

## Provenance, and what is NOT re-litigated

The STARTING MATERIAL is the §C orchestration design at PR #340 head
`6a53aae` (`docs/superpowers/plans/2026-08-14-decision-workflow-4b-4d.md`
there, §C + the unit-4d probe table in its §D and the uniform seal contract
in §C.3), carried here in substance — none reopened. The binding ledgers
(`docs/reviews/pr-335-convergence.md`, `docs/reviews/pr-340-convergence.md`)
stand; the merged 4b plan's §D carries obligations 4–6 to THIS unit as
named probes (P31b/P42b, P31c/P34b, P33b), elaborated in §B. The owner's
2026-08-13 AMENDMENT (forward authority = holder + PMC + architect once one
exists) is settled and carried. The Board decisions carried from 4c stand:
an operator-declared drain directive with NO automated drain actor
(2026-08-29, on PR #480); the seal-stripped migration run as the RED
evidence for new seals (the same date and PR); a consultation INFORMS and
never GATES (the same).

4b's and 4c's DELIVERED surfaces are settled input, and this plan is written
against what actually merged:

- **4b**: the decider model (`deciderKind` client/pmc/member/none on
  `Decision` — `'architect'` deliberately deferred to 4d WITH the role;
  `deciderMembershipId` bound by the composite FK to `Membership
  @@unique([projectId, id])`; the holder tuple frozen from publication or
  attribution by `Decision_t4b_attribution_seal`
  (`decision_t4b_attribution_seal`, `20270826000000` — the WRITE-ONCE door
  §A.2 loosens by exactly one opening); `phase6_t4b2_decision_seal`, whose
  role arms this plan widens; the orgs-owned holder-orphan guards
  `Membership_t4b2_holder_guard` / `OrgMembership_t4b2_holder_guard` and
  the participant answer `holdsOpenDecisions`; the user-TARGETED push spine
  with the catalog-declared claim-time predicate (`pushFamily: 'decider'`,
  bound at bootstrap to `decisions.deciderPushTarget`, the role's current
  holders resolved at claim through `roleHolderUserIds`); the §B.1
  try-acquire-or-refuse protocol and the §B.2 owned SQL primitives
  (`phase6_membership_is_active`, `phase6_effective_role_standing`,
  `phase6_user_decision_authority`, `phase6_decisions_hold_role`,
  `phase6_decisions_name_membership`); the `ChangeRequest` evidence freeze
  `phase6_t4b2_change_request_seal`; the `x-vitan-decisions-contract:
  recorded-v1` client boundary and its `RecordedCompatInterceptor`.
- **4c**: the two consultation tables with their seal network
  (`DecisionConsultation_t4c_request_seal`,
  `DecisionConsultationResponse_t4c_response_seal`, both judging
  `"publishedAt" IS NOT NULL AND status IN ('pending','change')` at lines
  4d-i REPLACES), the append-only and named no-TRUNCATE seals, the
  `openCycle` freeze; the two orgs-owned primitives 4c-i registered —
  `phase6_membership_active_user(projectId, membershipId)` (locks the
  membership row, returns its `userId` when ACTIVE) and
  `phase6_project_operable(projectId)` (locks `Project` before reading
  `archivedAt`) — and the decisions-owned `phase6_try_readiness(projectId)`,
  the DELIVERED "try-acquire, never wait in a trigger" primitive every 4d
  seal calls (its key is `readinessLockKey(projectId)` from
  `readiness-lock.ts`); the §C rule-ii command PROVENANCE shape — `NOT NULL
  sourceCommandId` with a project-contained composite FK to
  `CommandExecution(projectId, id)`, a `(projectId, sourceCommandId)`
  one-use UNIQUE, and the DEFERRABLE result-binding constraint trigger
  `phase6_t4c_provenance_bound` (+ `phase6_t4c_provenance_reserved`) tying
  the row to the RESULT of the reserved command executing it — also bound
  onto `DecisionApprovalRevision` (`DecisionApprovalRevision_t4c_provenance`,
  the partial one-use `DecisionApprovalRevision_source_command_key`); the
  per-event-FAMILY claim predicates (`pushFamily: 'decider' |
  'consultation_requested' | 'consultation_responded'`); the consultation
  claim predicates' delivered rule for an ARCHIVED project — project
  operability re-checked first, a non-operable project dropping the
  delivery with the recorded cancellation mark; and the RETIRED rollout
  latch — 4c-v dropped the per-project `consultation` capability entirely,
  so 4d inherits NO capability read and adds none.
- **The kernel**: `emitEvent` (`platform/events.ts`) locks and increments
  `ProjectEventStream`, writes the `DomainEvent` envelope with the
  catalog-built immutable `dispatchIntent`, and materializes one
  `OutboxDelivery` per registered consumer IN the caller's transaction
  (from 4d-ii, per ACTIVE consumer of the PERSISTED catalog, the rows a
  pure projection of the event — §A.3 obligation 7); the relay's
  `expandMissingDeliveries` repairs any event that lacks its delivery rows
  (a crash between event commit and delivery creation, a newly activated
  or reactivated consumer); the delivery lease is the sole arbiter of who
  sends; `cancelQueuedPushBySubject(tx, { projectId, subject, eventType })`
  is the platform's cancellation-by-subject over its OWN tables; the
  `Notification` feed table is platform-owned, written by the decisions
  service inside its command transactions and stamped with `decisionId`.
- **Three hand-offs the 4c plan recorded for THIS unit's review**, each
  taken up in §A: the `architect` joins the consultation REQUESTER set
  (`consultation.request` ceiling + a NEW orgs-owned orchestration-authority
  primitive — NOT a widening of `phase6_user_decision_authority`) "with the
  role"; the consultation eligibility carve-out gains the
  `awaiting_countersign` arm "with the status itself"; and the delivered
  `deciderPushTarget` reads its decision with a plain `findFirst`, which
  4c left for "4d's own review to weigh deliberately": §A.2 weighs it and
  changes it, because forwarding makes the holder MOVE.

Two delivered disciplines apply to every fact below without their own
probes, because the tripwires that pin them are merged and fail an
implementation PR that skips them: every new command rides the command
ledger with an idempotency key and joins the §A readiness-lock COMMAND-LEVEL
enumeration (`readiness-lock-coverage.test.ts`, `SECTION_A_COMMANDS`); every
new event joins the shared + sealed external-effect catalogs
(`external-effects.ts`, the sorted-tuple pin); every new table with a
statement-level no-TRUNCATE seal joins `TRUNCATE_SEALS` in
`prisma/sanctioned-reset.ts`; every new model joins its owning manifest's
`ownsModels` (and `readEncapsulated` where the module encapsulates its
reads) with the `boundary.test.ts` complete-set pins advanced, because the
boundary suite requires Prisma DMMF ownership to EXACTLY equal the
manifests; and every migration joins the `pg-parse` corpus pin and — where
it carries raw guards OR data a `prisma db push` baseline cannot have —
`ALWAYS_EXECUTE` in `scripts/migrate.sh`.

## §A — The design (the §C starting material, carried)

### 1. The role, honestly fanned out

`architect` joins `TokenRole` (`packages/shared/src/domain/types.ts`) and
EVERY mirror of it: `auth.ts`, BOTH zod role enums, `PushRole`, the
`decisionsManifest.permissions` set, the registry's hard-coded
`KNOWN_ROLES` mirror (`apps/api/src/platform/module-registry/registry.ts` —
`validateModuleRegistry()` rejects a manifest permission naming a role
outside that set and `ModuleRegistryService.onModuleInit()` aborts API
startup on the resulting `unknown-permission`, so a release that widened
the manifest without the mirror could not boot), the membership-role comment
in `schema.prisma`, and EXACTLY this `ROLE_POLICY` action set
(`packages/shared/src/domain/policy.ts`) — stated here, before the role
ships, so the route walk pins an intended boundary rather than whatever an
implementation chose (#561's review round 1, finding 2): the three reads
every project member holds, `project.read`, `members.read` (the roster the
consultation chooser needs) and `companies.read`; the four delivered
decision actions the architect performs as HOLDER or consultee,
`decision.approve`, `decision.updateDraft`, `decision.withdrawChange` and
`consultation.respond` — NOT `decision.change`: the §A.3 `ChangeRequest`
contract admits a `standard` request only from a role of the DELIVERED
`decision.change` set, which the architect is not in, and a policy row that
admitted the architect would let the call reach the transaction and be
refused by the origin seal instead of at the policy boundary (#572's review
round 3, finding 3; the architect's own change path is `decision.disagree`,
whose request carries `origin = 'countersign_rejection'`);
`decision.withdrawChange` keeps its delivered POLICY row, and its authority
— the requester or the PMC on an open `standard` request; 409 on
`countersign_rejection` — is SEALED rather than left to the service (#572's
review round 10, finding 1, correcting the sentence that used to stand here:
*"a service authority no DB seal judges, so policy and seal cannot disagree
there"*). Policy and seal agreeing was never the question. This plan models
a database-role writer holding a valid receipt throughout — it is the writer
findings 3 and 6 of round 4 exist to stop — and against that writer a rule
the service alone enforces is not enforced at all: an active engineer or
contractor who did not open the request could reproduce the whole protocol
(a truthful frozen resolver pair, a completed receipt, the closure, the
restoration, the event, the audit row), satisfy every seal this plan
installs, and withdraw somebody else's request. So the CLOSURE arm of
`ChangeRequest_t4d_provenance_required` — the arm that fires whenever `status`
leaves `'open'`, which is what a closure is, and not when the resolver column
is set, which is only what a well-behaved closure also does (#572's review
round 12, finding 1) — gains the predicate: for a
`standard` request closed to `withdrawn`, `resolvedById` must equal
`requestedById` OR hold `pmc` standing by `platform_user_holds_role` over
`ProjectUserStanding` — the same register obligation 3 judges every actor
against, under `phase6_try_readiness`, so no orgs-owned function is called
from a decisions seal. P33 gains the truthful-but-unauthorized closer: an
ACTIVE engineer who is neither requester nor PMC, carrying every other
column correctly, REFUSED — RED against the unsealed arm, which commits it;

`consultation.request`, because the architect joins the requester set; and
three of the four NEW 4d actions of §A.2 — `decision.forward` (its row
lists every role that can hold a decision, the forward door judging
holder-ness), `decision.countersign` and `decision.disagree` (`architect`
only). ELEVEN actions, no other. Deliberately NOT: `decision.change`
(above), `decision.create`,
`decision.publish` and `decision.withdraw` (issuing and withdrawing stay
the PMC's), `decision.resolveStrandedCountersign` (`pmc` only), `org.create`,
and every requirement, procurement, stock, labour, commercial, activity,
inspection, daily-log, media and drawing action — the architect's authority
is the decision workflow and nothing adjacent. P28's `route-policy.test.ts`
arm asserts EQUALITY: for every action in `ROLE_POLICY`, `architect` is in
its role list iff the action is one of the eleven, so an accidental widening
onto a commercial or payment action and an omitted read both fail the pin.

**And the set is RECONCILED against the seals, not merely declared** (#572's
round-3 root-cause audit). An equality pin proves this list matches
`ROLE_POLICY`; it cannot prove the list matches what the §A.3 seals will
ALLOW, and that gap is exactly where `decision.change` sat for three rounds —
granted here, refused by the origin seal, each page self-consistent. So every
action granted here names the seal that judges the act it authorizes, and a
grant whose seal would refuse the actor is a defect in this plan: fixed by
narrowing the grant or by deliberately widening the seal WITH its probes,
never by leaving both standing. **The EXISTING targeted catalog entries
whose ceilings the role must enter** are widened too: `decision.published`
and `decision.consultation_requested` in `EXTERNAL_EFFECTS` list every role
a decider or consultee can hold, and their emitters persist the named
member's ACTUAL role even for a user-targeted push — which
`buildDispatchIntent` rejects when the role is outside the ceiling, aborting
the whole command. 4d-ii widens both, and a catalog tripwire enumerates every
targeted entry whose narrowing site persists a member role and asserts each
admits the full member vocabulary; P28 probes both paths end to end. **The
fan-out includes the PRODUCT PATH that mints memberships**: the Team screen's
role picker and role labels (`TeamScreen.tsx` `ROLES` / `ROLE_LABEL`,
`RolePicker.tsx` `ROLES`, and every web role list the mirrors walk reaches)
gain `architect`, or the countersign chain could activate only through
direct API calls, which is not a shipped feature. The role is a project
MEMBERSHIP role like the other five; `worker` stays deliberately absent from
the zod allowlists; the EXISTING `CompanyKind`/discipline vocabulary that
already spells `architect` (a firm's kind, a consultant's discipline) is a
different axis and is untouched.

**The role is a DESIGNATION, not only a token.** The 4b plan deferred
`'architect'` in `DeciderKind` to 4d explicitly, and the delivered contract
admits `client | pmc | member | none` everywhere it is judged — the Prisma
`DeciderKind` enum, the zod `DECIDER_KINDS`, the shared type,
`viewerIsDecider` (`packages/shared/src/domain/decider.ts`, false for any
kind it does not know), `deciderNoun`, the role arms of the two 4b seals
(the open-holder rule in `phase6_t4b2_decision_seal` and the holder-orphan
audit both judge `deciderKind IN ('client','pmc')` by
`phase6_effective_role_standing`), the decider picker and the audience
selectors. So the designation fans out with the role: 4d-i adds the enum
value in the retry-safe form the 4a/4b files used (`ALTER TYPE "DeciderKind"
ADD VALUE IF NOT EXISTS 'architect'`, its own statement, issued only AFTER
the transaction that installs the five TEXT-judged reservation doors below has
committed) and adds a SEPARATE architect arm to both 4b seals — `deciderKind =
'architect'` judged by `platform_role_standing(project, 'architect') ≥ 1`
over the platform register the orgs trigger writes, the delivered
`client`/`pmc` arm left byte-identical on `phase6_effective_role_standing`
(#565's review round 1, finding 1: widening the delivered arm's set would
have sent the architect branch of a decisions-owned seal through the
orgs-owned function that reads `Membership`, `OrgMembership` and
`Project` — the decisions → orgs read the register exists to remove) —
so an open decision designated to the architect role must have an
effective architect holder exactly as a `pmc` one must a PMC — the
holder-orphan audit's architect arm judging the POST-write count because
the register's trigger runs BEFORE ROW (#565's review round 2, finding 1); 4d-ii adds the value to the shared type, `DECIDER_KINDS`,
`viewerIsDecider` (`architect` designates the ROLE — any active architect
decides, the `client`/`pmc` shape), `deciderNoun`, the DTO, the decider
picker, the audience selectors, the labels, AND the PRODUCER that selects
the push audience: `DecisionsService.deciderPush` maps `member` to its named
user, `pmc` to the PMC role and EVERY other kind to `client`, so a widened
input union alone would push "New decision awaiting your approval" for an
architect-designated decision to the CLIENTS; it gains an explicit
`architect` arm (`roles: ['architect']`, the role fan-out the widened
`decision.published` ceiling admits — this delivered family keeps its
delivered claim-time resolution through `roleHolderUserIds`, the per-recipient
re-judge of §A.2 guarding each send), the delivered `deciderPushTarget`
claim predicate gains the same arm (an architect-designated decision is
actionable while an active architect holds the role —
`RoleStandingQuery.activeCount ≥ 1` over the platform register, the
`pmc`/`client` shape with the architect's read routed through the kernel),
and the
forward door's role-`toDesignation` arm (§A.2) admits it unchanged. P28's
role-held arms, RED at base (zod refuses the value; `viewerIsDecider`
returns false): a PMC creates a decision with `deciderKind: 'architect'` and
forwards a pending one to the architect role designation; every active
architect sees each in the Decision Log and one of them approves (an
architect-designated approval under an active chain still lands
`awaiting_countersign` — the chain judges it like any other, P32's two-key
self-countersign rule applying); a removed architect sees neither; the
publication's RECIPIENTS are every active architect's links and no client
link; and the P39 role-designation arm refuses removing the LAST architect
while a `pending`/`change` decision names the role (exactly the
`client`/`pmc` rule — the chain exemption of §A.2 covers an
`awaiting_countersign` decision designated to the role as it covers one
naming the architect by membership). **And the viewer-scoped
`DecisionsQueryService.countPending`** — the Portfolio tile count whose
predicate today gives a non-PMC viewer only client-designated rows or rows
naming their membership — gains the `architect` role arm (an active architect
counts the `pending` decisions designated to the role) and counts the
viewer's `awaiting_countersign` obligations (an architect's pending
countersigns; the PMC's stranded ones while the chain is inactive), the
portfolio probe asserting the architect's card reports them, zero at base
— and `SnapshotService.shellSummary`'s `pendingDecisions`, the project
shell and nav badge, is served by that SAME `countPending` (today it counts
`status === 'pending'` rows itself and never calls it — #561's review round
1, finding 6), so the badge and the Portfolio tile agree and P31's badge
assertion holds for one `awaiting_countersign` decision and no pending
one.

**The role is DELIVERED DARK and armed only after the drain** (§D — the 4c
rollout discipline applied to 4d's own mixed-version hazard). 4d-i installs
an orgs-owned RESERVATION on `Membership` refusing any INSERT or UPDATE whose
NEW row carries `role = 'architect'` — judged on NEW regardless of OLD, so a
removed row already in that role can be neither restored nor re-keyed into
service through it (the exact shape of 4c-i's `ProjectCapability_t4c_reserved`)
— dropped by the trailing migration-only unit 4d-iii once the previous
release is attested drained. **The reservation covers EVERY 4d producer**:
the architect reservation keeps the CHAIN off, but forwarding needs no
architect, so 4d-ii's `decisions.forward` would emit `decision.forwarded`
while an ALREADY-RUNNING previous-release push worker — fenced by the
consumer version bump only when it RESTARTS — could still claim that
delivery, know no `forward` family, and take the unguarded send path. 4d-i
therefore ALSO installs `DecisionForward_t4d_reserved` (a BEFORE INSERT
trigger refusing EVERY `DecisionForward` row), `Decision_t4d_architect_reserved`
(a BEFORE INSERT OR UPDATE trigger refusing ANY `Decision` row whose
`deciderKind` is `architect`, draft or published — the delivered
`DecisionsService.create` births an unpublished DRAFT carrying its
`deciderKind` before any standing check, and a pre-4d process reads the
project's rows through its old Prisma enum BEFORE the author-visibility
filter, failing on the unknown value) and `Decision_t4d_awaiting_reserved`
(refusing ANY `Decision` row whose `status` is `awaiting_countersign`) — FOUR
doors through ONE shared refusal function `phase6_t4d_reserved()`, all
dropped by ONE 4d-iii statement. **The two `Decision` doors PRECEDE the enum
values**: they are created in their own transaction BEFORE the `ADD VALUE`
statements, judging the row AS TEXT — `NEW."deciderKind"::text =
'architect'`, `NEW."status"::text = 'awaiting_countersign'` — which PostgreSQL
evaluates whether or not the value exists yet, so no window opens in which
either value is representable and unreserved. **No `Decision` row can
PRE-DATE 4d-i carrying either value**: `DecisionStatus` and `DeciderKind` are
PostgreSQL enum types, and a column of an enum type cannot hold a value the
type lacks — so there is no `Decision` audit, no reserved-value repair and no
repair-evidence register for decisions (§A.4 records what #552 carried here
and why it is withdrawn). On the service path `decisions.forward`,
`decisions.create`/`updateDraft` naming `deciderKind: 'architect'`,
`MembersService.add` and the role-update command each refuse 409 naming
`phase-6-4d-previous-release-drained` while the reservation stands — judged
the way the database judges it, by the reservation trigger's presence in
`pg_trigger` (one catalog read, under the readiness lock, the read
`upgrade-proof.sh` already performs), and for the two membership commands
BEFORE ANY WRITE, ahead of the `User` provisioning the delivered
`MembersService.add` performs before its membership transaction (a trigger
refusal at the membership INSERT would otherwise orphan the invited
identity; that pre-existing provision-before-transaction ordering is an
orphan hazard for ANY membership failure and is named here, not widened
into 4d). The web Forward affordance and the Team role pickers follow ONE
shell-level `rollout.phase6_4d: 'reserved' | 'open'` read baked from the same
catalog read, so no client offers what the server refuses (ui-server-parity;
P34's web arm, P28b's service arm: adding an architect by a NEW email while
reserved → 409 and ZERO `User` rows created; after 4d-iii the same call
creates the member). P29c probes the SIX doors in both states: with the
reservation ARMED a service forward is 409, a hostile direct
`DecisionForward` insert is refused, the outbox holds no
`decision.forwarded`, no Forward renders, a service create naming the
architect designation is 409 and a hostile direct draft insert is refused;
after 4d-iii all open, and a published architect-designated decision is then
judged by the open-holder rule.

**The reservation is installed only onto a database that holds NO such
row.** `Membership.role` is an unconstrained `String`, so a pre-existing row
already spelling `architect` — a value nothing validated because no
vocabulary admitted it — would survive the reservation untouched and arm the
chain the instant `phase6_effective_role_standing` learns the role. 4d-i
therefore carries a DIAGNOSTIC-FIRST audit (the delivered `ABORT` pattern of
20271015/20271120) — ordered AFTER the reservation is installed, inside the
same transaction: the `CREATE TRIGGER` takes ACCESS EXCLUSIVE on
`Membership`, so every concurrent writer blocks until this transaction ends,
AND the transaction takes `LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`
and installs the FIFTH door, `User_t4d_architect_reserved` (BEFORE INSERT
OR UPDATE on `User`, `role = 'architect'` judged as text, the same shared
refusal function), BEFORE the audit (#558's review round 1, finding 5: the
membership lock could not block a concurrent `User(role = 'architect')`
creation, so a still-serving `ensure-accounts` could commit its user after
the audit counted zero, be refused only at its membership upsert, and leave
a residual user behind a migration that recorded success — the `User` lock
and door close that ordering: the user write waits, then is refused by the
door, and the audit's zero holds); only THEN does the audit count `Membership` rows with `role = 'architect'` in
ANY status (the ordinary team removal sets `status = 'removed'` and leaves
`role` in place, so a soft-removed row aborts identically) and ANY `User` row
with `role = 'architect'` (the dev-session fallback reads `User.role`
verbatim), and if either count is not zero it RAISES with a bounded sample
and the WHOLE transaction rolls back, the trigger included — never re-roles,
never deletes. Auditing before the trigger would leave the classic gap: a
writer inserting an active architect row after the count observed zero and
before `CREATE TRIGGER` took its lock would be grandfathered past the
reservation. Both orderings are barrier-probed on the shipped file exactly
as 4c-iii's transition race is (P28b): writer-first — the migration waits at
`CREATE TRIGGER`, then its audit sees the committed row and ABORTS;
migration-first — the writer waits, then is REFUSED by the reservation
(the `User` write by the fifth door, the `Membership` write by the first,
so no residual user is ever left behind). **The
operator repair is a RE-ROLE, never a soft removal, and never a repair
engine**: the still-serving pre-4d client reads `Membership.role` as the
`String` it is, so the ordinary team role command re-roles every offending
row to the role the member actually holds (the aborted attempt installed
nothing, so that UPDATE is free), or — for a row that never legitimately
existed — the documented operator SQL deletes it, subject to the delivered
4b holder guards, which refuse deleting the named holder of an open decision
(that row is re-roled instead); a dev `User` fixture is re-roled the same
way. The audit abort follows the committed door and enum statements, and
Prisma records the attempt as failed, so a plain redeploy stops at P3009: the
recovery is repair → `prisma migrate resolve --rolled-back <the 4d-i
migration>` → redeploy, exactly the repository's 4c-iii-r path in
`apps/api/scripts/migrate.sh` (`report_4c_iiir_migration_failure`), which
gains a `report_4d_i_migration_failure` twin printing those three steps when
this file fails; `docs/RUNBOOK.md` gains the §P6T4D section; and
`upgrade-proof.sh` plants BOTH an active and a soft-removed hostile
`Membership` row and a dev `User` row and drives abort → re-role → `migrate
resolve --rolled-back` → redeploy through the REAL runner, never a direct
SQL re-run that bypasses Prisma's failed-migration ledger. The P3005 baseline
path cannot skip the audit because the migration is in `ALWAYS_EXECUTE`.

Until 4d-iii no project can hold an active architect, so no chain can
activate, no decision can enter `awaiting_countersign`, and no JWT can carry
the role — INCLUDING the dev session: in a non-production environment with
`ALLOW_DEV_AUTH=true`, `AuthService.session` falls back to minting
`dev-<role>` for a role with no matching user and otherwise issues the real
`User.role` verbatim, so it REFUSES an `architect` request BEFORE EITHER
BRANCH — 409 naming the drain directive — until `rollout.phase6_4d` is open,
and the synthetic `dev-<role>` fallback NEVER mints `architect` even after it
(a synthetic actor has no account, so no fact it wrote could satisfy the
`<act>ByName` seal of §A.2; a dev architect is a seeded `User` fixture the
real-user branch serves once the rollout is open); P28b covers this alternate
token producer in both arms. "Activating the chain" is thereafter a
per-project PRODUCT act — the PMC adds an architect member — never an
operator step.

### 2. Orchestration

The settled design, plus the owner's 2026-08-13 amendment, as behaviour.
Every fact this section names lives under the uniform seal contract of §A.3;
the paragraphs below state what each seal JUDGES, and §A.3 states the seven
obligations once.

#### Forwarding

An append-only `DecisionForward` chain: `projectId`, `decisionId`,
`fromDesignation` (the DISPLACED holder: kind + membership), `toDesignation`
(the new one), `forwardedById` (the ACTOR — forward authority includes
non-holders, so a PMC forwarding a client-held decision is recorded as the
PMC displacing the client) with the action-time `forwardedByRole` and
`forwardedByName` frozen beside it, `reason`, `at`, and the delivered
provenance shape (`sourceCommandId`) — all immutable. The HOLDER is not a
new concept: it is the decision's CURRENT decider designation (4b §A.1) —
forwarding re-points that designation and the chain records each hop, so
every pending surface, badge and push that "follows the decider" follows the
forward automatically. **Forwarding EMITS**: `decision.forwarded` joins the
catalog (`invalidate: true`, a user-targeted push at the NEW holder,
`pushFamily: 'forward'`, its recipients frozen at emission — the push
families below). **The holder is mutable ONLY through the recorded act, and
the act must MATCH the change**: the 4b write-once trigger that ACTUALLY
freezes the holder — `Decision_t4b_attribution_seal`
(`decision_t4b_attribution_seal`, whose published-or-attributed arm refuses
any change to `deciderKind` or `deciderMembershipId`; not
`phase6_t4b2_decision_seal`, whose arms are the role arms) — loosens to
exactly one opening: a change accompanied by a same-transaction
`DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns
and whose `toDesignation` EQUALS the NEW ones, and the two DIFFER —
and, in the SAME `CREATE OR REPLACE`, its two APPROVAL clauses are widened
for exactly the sealed provisional transition (#567's review round 2,
finding 3: the delivered function admits the frozen approval tuple's first
write only on `pending`/`change → approved` and forbids an approval-bearing
`change` row from leaving `approved`/`change`, so the provisional approve
under a chain — `pending → awaiting_countersign`, the tuple written by the
provisional act as the finalizing act wrote it — and the chain reapproval
`change → awaiting_countersign` would both abort before the pairing seals
ran): the tuple-write arm admits `→ awaiting_countersign` beside
`→ approved`, and the standing arm admits `change → awaiting_countersign`
beside `change → approved`, each admitted only where the approved-entry
seal's awaiting arm and its DEFERRED pairing (§B.4) judge the same
transition; the INSERT clause — a tuple belongs only to an approved
decision — is KEPT, a decision never being born awaiting (the entry seal's
INSERT arm, below); P31 drives both chain flows through the widened
function, RED at the delivered one (the
command refuses a same-target forward 409 "already the holder"; the
holder-door arm requires the holder columns to actually change; the
forward-side reverse seal refuses a row whose `from` equals its `to`). Mere
row presence is forgeable — a hostile transaction could insert a forward row
naming unrelated designations and re-home the holder to a third member — so
the seal compares the transition to its evidence field-for-field. **The
pairing is sealed in BOTH directions**: a `DecisionForward` INSERT is
refused at commit (a DEFERRED constraint trigger) unless the SAME
transaction carries the matching holder mutation, exactly as the holder
trigger checks it from the decision side; an orphan row would fabricate
immutable handoff evidence for a handoff that never happened. **The DOOR is
status-gated AND PUBLICATION-gated**: forwarding is legal only in states the NEW
HOLDER can act on — `pending` and `change`, CAS'd on status at the command AND
required by both DB doors — **and only on a PUBLISHED decision, `publishedAt IS
NOT NULL`, at the command and at both doors** (#572's review round 21,
finding 2). Status alone is not the question, because an unpublished DRAFT also
carries `status = 'pending'` (`decisions.service.ts:194` creates it that way and
`:213` stamps `publishedAt` only on publication), and a draft is its author's
private workspace: `decisionVisibleToViewer` hides it, so the target of a
forward could not see the decision they had just been made the holder of. Every
effect would still commit — the holder mutation, the IMMUTABLE `DecisionForward`
row, the event, the notice and the push — handing someone an action item that
renders as nothing and routing round the draft-only `updateDraft` workflow that
exists for exactly this state. The delivered code already draws this line one
command over: `assertConsultationEligible` refuses when `publishedAt === null`
(`decisions.service.ts:58`), and the forward door is the sibling that did not.
P30 gains the unpublished-`pending` row: the forward REFUSED at the command and,
planted directly, refused at both doors, with no `DecisionForward`, no holder
change, no event and no push; terminal states refuse; `awaiting_countersign` is EXCLUDED from
the generic command (that status is the ARCHITECT's action item) and the DB
door admits `awaiting_countersign → change` ONLY when the transaction also
carries the `countersign_rejection` request (the disagreement's forward-on,
below). **The TARGET must be able to act, judged at the DB too**:
`toDesignation` validates through the orgs participant as an ACTIVE
same-project member/role (a removed-target forward is 409), and the
holder-door trigger validates the NEW holder's standing — a named-member
`toDesignation` must resolve through `platform_membership_active_user` (the
composite FK pins existence and project; ACTIVE standing is the primitive's
read, under the membership row lock), a role `toDesignation` must have at
least one holder in the per-user register — `platform_role_has_holder(project,
role)`, an EXISTS over `ProjectUserStanding`, which is populated for EVERY
role, whereas `ProjectRoleStanding` carries the `architect` count alone
(#562's review round 2, finding 2: judging a live `client` or `pmc` target
by the count register refused every valid role forward) — the standing
read riding
`phase6_try_readiness` as every seal-trigger standing read does. **The
recorded ACTOR must be able to perform the act**: `forwardedById` must hold
ACTIVE standing granting forward authority — the current holder's own user
(the named membership's user via `platform_membership_active_user`; for a ROLE
designation, a user who HOLDS that role via the NEW platform kernel read
`platform_user_holds_role(project, user, role)`: TRUE iff the platform-owned
per-user register `ProjectUserStanding` below holds a row for THIS user in
that role — an ACTIVE membership in that role, or for `pmc` the
membership-less org owner/admin — read under `phase6_try_readiness`, never
"someone holds it"), or `pmc`/`architect` via the NEW kernel read
`platform_user_orchestration_authority(project, user)` — a `pmc` or
`architect` row in the same register — and NOT via a widened
`phase6_user_decision_authority`, which is the DB backstop for
decision-CREATE authority and stays byte-identical so a direct insert
attributed to an architect cannot pass the seals this plan keeps PMC-only.
**No decisions-owned seal invokes an orgs-owned function** (#561's review
round 1, finding 1: `decisions.dependsOn` is `[]` and `orgs.dependsOn`
names `decisions`, so a decisions trigger calling an orgs-owned SQL
function — however the function is registered — was a synchronous read of
a peer's table closing a cycle; the standing therefore reaches the seals
exactly as the role COUNT does, projected by its owner into a platform
register the kernel serves). The `reason` carries the sibling non-blank discipline as 4c-i spelled
it: `NOT NULL` AND `CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '')` beside
zod `trim().min(1)`. Forward authority: the current HOLDER + the PMC + the
architect once one exists (the AMENDMENT). **The architect can SEE what the
architect may forward**: the canonical `decisionVisibleToViewer` shows a
`pending` decision to the PMC, the decider and a standing consultee only, so
the audience widens by EXACTLY one more arm, the consultee precedent: while
the chain is ACTIVE an active architect sees every `pending` decision of the
project (and every `awaiting_countersign` one — already the architect's own
obligation), in the ONE shared predicate (`decisionVisibleToViewer`, its web
mirrors `selectLogDecisions` / `selectVisibleDecisions`, and the projection
read-path filter), gaining no authority by sight; `change`, `approved` and
`recorded` stay as today, `withdrawn` stays pmc-only, and with no chain the
predicate is byte-identical (P29). **Forwarding SERIALIZES against approval
and countersign**: each of approve/countersign/forward takes the locks in
the ONE canonical order — `lockProjectReadiness`, then `Project`, then
`Membership`, then the decision's subject delivery rows `FOR UPDATE` in
ascending id order, then the `Decision` row (#558's review round 2, finding
5: an earlier wording here took the decision row immediately after
readiness while the relay leases a delivery before waiting on the decision,
a deadlock this order forecloses) — and re-checks the holder INSIDE the
transaction, so the loser of either ordering is a deterministic 409 —
barrier-probed in BOTH orderings against that exact sequence (P35). Every hostile shape is probed under P34: no row; a mismatched row; the
orphan row; the same-target no-op at both doors; a matched row on a
terminal or awaiting decision; a matched row naming a removed membership or
an empty role; an inactive or unauthorized actor, and the role-holder arm's
own — another user holds the client role while the recorded actor does not;
the web arm drives a NON-holder architect forwarding a client-held pending
decision through the shipped UI, RED at base where the audience rule hides
the row.

#### The chain switch, and the standing that decides it

**No chain until an architect exists — and "exists" means an ACTIVE
membership**: rows are soft-removed, so mere presence would leave the chain
armed after the only architect left. The switch is "an ACTIVE architect
membership exists", read through the orgs participant on the service path
and through `platform_role_standing(projectId, 'architect') > 0` over the
kernel register at the DB — never the orgs primitive from a decisions seal
(#562's review round 1, finding 1). **The switch's WRITERS serialize with its readers**:
approve/countersign/forward/the stranded resolution read the switch under
`lockProjectReadiness`, and the orgs-side mutations that can flip architect
presence (role update, removal/restore, activation) take the SAME lock when
the role entering or leaving is `architect`, joining the §A lock-coverage
enumeration; a role-change-vs-approve barrier probe covers activation AND
deactivation in both orderings (P36). A project that removes its only
architect DEACTIVATES the chain for NEW approvals; a decision already
`awaiting_countersign` is NEVER auto-flipped (the stranded resolution
below).

**The standing lives in the platform kernel, so no module reads a peer's
table for it.** A platform-owned register `ProjectRoleStanding(projectId,
role, activeCount, changedAt)` — primary key `(projectId, role)`,
same-project FK to `Project` `ON DELETE CASCADE`, `activeCount >= 0` CHECK,
registered in `platformManifest.ownsModels` — is served by a platform-owned
`RoleStandingQuery.activeCount(tx, projectId, role)`, the kernel's contract,
exactly as `CapabilitiesService.isEnabled` serves `ProjectCapability` to
every module. Its ONLY writer is the GENERIC platform primitive
`platform_role_standing_apply(projectId, role, delta)` — `INSERT … ON
CONFLICT ("projectId", "role") DO UPDATE SET "activeCount" = "activeCount"
+ delta`, knowing no role and reading no table — called by the ORGS-owned
`Membership_t4d_role_standing` trigger, BEFORE INSERT OR UPDATE OR DELETE
FOR EACH ROW on `Membership` — BEFORE, not AFTER (#565's review round 2,
finding 1: the delivered `Membership_t4b2_holder_guard` is an AFTER
trigger, PostgreSQL fires same-kind triggers in name order, and `t4b2`
sorts before `t4d`, so an AFTER register trigger would have applied its
delta only after the guard's architect arm had read the register — the
removal of the last architect under a designated open decision saw `1`,
passed, and left the count at zero; a BEFORE ROW trigger applies the delta
before the row is written, so every AFTER guard on `Membership` judges the
POST-write count, for one row and for every row of a multi-row statement
alike, a row a later constraint refuses rolling its delta back with it;
the reservation and readiness doors sort before it by name and refuse
first; the decisions-owned guard is NOT taught the membership delta — the
order is the orgs trigger's to fix) — which computes the change from the
row it is handed and NOTHING else — `before := (OLD.role = 'architect' AND OLD.status =
'active')`, `after := (NEW.role = 'architect' AND NEW.status = 'active')`,
delta `after − before` — and calls the primitive when the delta is non-zero:
no read of `Membership`, no read of any decisions table, no count, and NO
EMISSION (§A.4). The dependency runs orgs → platform, as every module's does
(#554's review round 2, finding 4: a platform-owned trigger on the orgs-owned
table interpreting the application role `architect` would have put
orchestration in the leaf); the register's writer seal below admits only a
write nested inside a trigger, which the orgs trigger's call is. The register is generic in shape so
a later unit can carry other roles; 4d maintains the `architect` row only,
and `phase6_effective_role_standing` stays the authority for `client`/`pmc`
exactly as delivered. It agrees with the orgs primitive BY CONSTRUCTION, not
by a cross-module check: both are functions of the same `Membership` rows, a
row trigger fires for every row write, and the register's own seals admit no
other writer — a BEFORE INSERT OR UPDATE OR DELETE seal refusing any write
that arrives at `pg_trigger_depth() = 1` (a statement issued directly) and
admitting only a write nested inside another trigger: the standing trigger's,
or the cascade of the project's own deletion, recognized by depth AND the
transaction-local flag the orgs-owned `Project_t4d_deleting` BEFORE DELETE
trigger on `Project` sets (4c-iii's `Project_t4c_deleting` shape reinstalled
under a 4d name, since 4c-v retired the original); the CHECK turns a delta
that would go negative into a refusal, never a clamp; the statement-level
`ProjectRoleStanding_t4d_no_truncate` and `Membership_t4d_no_truncate`,
both registered in `TRUNCATE_SEALS`, so the rows the register counts cannot
vanish beneath it. 4d-i backfills one `architect` row per project from a
count taken in the migration (zero, which the audit proves) through an
EXPLICIT gated writer arm of the seal — `INSERT … SELECT … WHERE NOT EXISTS
(the project's row) … ON CONFLICT DO NOTHING` under `SET LOCAL
vitan.phase6_4d_standing_backfill = 'on'`, the seal admitting a depth-1 write
ONLY under that gate and ONLY as a zero-count `architect` insert — a
VALUES-only condition, with no predicate on the target row's absence — so
every `ALWAYS_EXECUTE` replay re-runs the backfill for a project created since
(a project without an architect membership has no row until its first standing
write) and commits, while the same statement outside the gate is refused
(#560's review round 2, finding 5: the depth-only seal would have refused the
replay's own insert and made 4d-i unreplayable). **The exclusion belongs to the
STATEMENT and not to the seal** (#572's review round 9, the sweep behind
finding 2): a seal clause reading "for a project that has no row" is evaluated
by a BEFORE INSERT trigger on the speculatively inserted row, which fires
BEFORE the conflict is detected — so on a mature database it would raise for
every project of the original backfill and the `ON CONFLICT` clause would never
be reached, re-breaking the very replay this arm exists for. The clause was
also doing no security work, since a gated zero-count insert onto an existing
row is discarded by the unique index regardless;
`upgrade-proof.sh` asserts register = count over the legacy fixture, P29b
asserts it after EVERY transition shape (insert, activate, soft-remove,
restore, re-role in and out, through the service; the project cascade), and
an operator `platform:verify` diagnostic compares the two OFFLINE, never in a
transaction.

**4d-iii's fenced re-projection is the SECOND gated writer arm, and it needs
its own gate for the same reason the backfill did** (#572's review round 5,
finding 4). When the admitted drain-window race actually leaves a
`ProjectUserStanding` or `OrgUserAuthority` row missing — or a surplus one —
4d-iii's repair must INSERT and DELETE register rows to make them equal to
the orgs truth, and it issues those statements from the migration: a depth-1
register write, which is exactly what the writer-depth seal exists to refuse.
The seal admits nested writes plus the backfill's own gate, and nothing else,
so the repair as previously written is refused and 4d-iii rolls back — the
migration whose whole purpose is to close the window cannot run. This is the
round-4 backfill finding arriving at the other gated writer: a seal that
admits one named exception needs the second one named too, not assumed.

The arm is therefore `SET LOCAL vitan.phase6_4d_standing_reprojection =
'on'`, and it is narrower than the backfill's in three ways that keep it from
becoming a general door. It is admitted ONLY while the 4d-iii table fence is
held (the seal asserts the three orgs tables are locked in the current
transaction, which no ordinary writer holds), ONLY for writes that move a row
TOWARD the orgs truth the same transaction has already snapshotted, and ONLY
on the two per-user registers — `ProjectRoleStanding`, the counted register,
is not repairable through it, because its own arithmetic seal is the thing
that keeps the count honest. Outside those conditions the gate refuses
exactly as the ungated statement does. P42's re-projection arm gains the
negative: the same repair statements issued WITHOUT the gate, and with the
gate but without the fence, are each refused, so the gate is proven narrow
rather than merely present. **Per-user standing and identity live in the kernel the same
way** (#561's review round 1, finding 1): the platform-owned
`ProjectUserStanding(projectId, userId, role, membershipId)` register — a
row present iff that user holds ACTIVE standing in that role on that
project (an active membership in the role, the row naming it; or, for
`pmc`, an org owner/admin with no active membership on the project — the
membership-less arm the token role and the project access path already
admit, `membershipId` NULL), same-project FK to `Project` `ON
DELETE CASCADE`, the same writer-depth seal, `ProjectUserStanding_t4d_no_truncate` in
`TRUNCATE_SEALS` — and the platform-owned `UserIdentity(userId,
displayName)` register with the same seal shape and
`UserIdentity_t4d_no_truncate` — and, for team-management AUTHORITY as
distinct from token ROLE, the platform-owned `OrgUserAuthority(orgId,
userId, role)` register (an owner/admin row per org membership in those
roles, projected by the `OrgMembership` trigger, `OrgUserAuthority_t4d_no_truncate`;
#562's review round 1, finding 2). Their ONLY writers are the generic platform
primitives `platform_user_standing_apply(projectId, userId, role, present)`,
`platform_user_identity_apply(userId, displayName)` and
`platform_org_authority_apply(orgId, userId, role, present)`, knowing no
role and reading no table, called by ORGS-owned triggers that read only
orgs tables: a NEW `OrgMembership_t4d_org_authority` (an owner/admin
insert, promotion, demotion or removal writes that user's authority row
for the org — #562's review round 2, finding 1: the register was
introduced without a writer, so every owner/admin holding a non-PMC
membership would have failed the authority seal), the extended `Membership_t4d_role_standing` (a membership's
activation, deactivation, removal, restoration or re-role writes the
user's row for the old and the new role AND recomputes that user's
conditional membership-less `pmc` row on that project whenever their
active-membership presence changes — an org owner/admin who gains an
active membership loses the `pmc` fallback, since their standing is now
the membership's role, and one whose last active membership ends regains
it; #561's review round 2, finding 1: writing only the old and new role
rows preserved `pmc` for a new engineer and never restored it for an
owner), a NEW
`OrgMembership_t4d_user_standing` (an owner/admin gain or loss writes the
`pmc` row on EVERY project of the org where the user has no active
membership — the fan-out the org writers already serialize under the org
key from 4d-iii), a NEW `Project_t4d_user_standing` AFTER INSERT (a new
project seeds the org's owners and admins as `pmc` rows), and a NEW
`User_t4d_identity` AFTER INSERT OR UPDATE of the display name (a new
account is projected the instant it exists; a rename rewrites the row —
#561's review round 2, finding 7: a rename-only trigger left an actor
provisioned after 4d-i without an identity row, so every fact of theirs
would have been refused).
**And the row FALLS with its user** (#572's review round 4, finding 4). The
trigger covered insert and rename and said nothing about deletion, while
`UserIdentity` is sealed and non-truncatable and the seed and the integration
fixtures HARD-DELETE `User` rows. Either outcome was wrong: the delete fails
on the identity row's FK and no reset completes, or the row outlives its user
and `platform:verify` reports orphaned identity evidence forever. So
`UserIdentity.userId` carries `ON DELETE CASCADE`, and the seal ADMITS that
cascade explicitly — a nested delete at trigger depth from the owning `User`
row, exactly as the register's other writes are admitted only from their
owner — while a direct `DELETE` against `UserIdentity` stays refused. The
sanctioned reset needs no new step: the cascade fires from the `User`
deletion the reset already performs. P28b asserts both halves — reseeding a
database whose users are deleted leaves NO `UserIdentity` row behind and
`platform:verify` is clean, and a hand-run `DELETE FROM "UserIdentity"` is
still refused.
4d-i backfills all three registers from the current orgs truth under the
same gated writer arm as the role register; `platform:verify` compares
them OFFLINE against the orgs tables; P28b/P29b assert all three after
every transition shape. **The drain window is re-projected before the
doors close** (#562's review round 2, finding 3): between 4d-i and 4d-iii
no org-key door serializes a `Project` INSERT against an owner/admin
`OrgMembership` INSERT, so each AFTER trigger can run before the other's
uncommitted row is visible and both commit with no `pmc` row for a valid
holder; 4d-iii therefore RE-PROJECTS `ProjectUserStanding` and
`OrgUserAuthority` from the orgs truth, org by org in ascending id, inside
the same transaction and BEFORE it installs a door or drops a reservation
— a verify-and-repair whose diff is recorded in the migration's closing
report, issued under the re-projection gate the registers' writer-depth seal
admits for exactly this transaction (§A.2, #572's review round 5, finding 4). **The repair is taken behind a table fence, not behind the org
key** (#563's review round 2, finding 1: a repair serialized by
`lockOrgStanding` alone excludes only the writers that take the key, and
a direct SQL writer takes none — a `Project` INSERT and an owner/admin
`OrgMembership` INSERT could both commit after the repair's snapshot and
before the doors were installed, and the migration would commit without
the `pmc` row a valid owner is owed): the FIRST statement of 4d-iii's
transaction after its `SET LOCAL` gate is `LOCK TABLE "Project",
"OrgMembership", "Membership" IN SHARE ROW EXCLUSIVE MODE` — the mode that
conflicts with every row write from any writer, service or direct, and
the mode the door installations themselves take — taken in that ONE
order, before the snapshot and before any door, and held to commit. The
lock request waits for every in-flight write of those tables to end, so
every write that began before the fence is committed or rolled back and
visible to the repair's snapshot; no write can commit between the
snapshot and the doors; and the first write after the commit meets the
installed doors. The migration takes NO org key — the fence subsumes it
for the three tables, and a key taken after the fence could deadlock
against a service writer that holds the key and is waiting on the fence
(a writer holding the key simply waits, commits after the migration, and
meets the doors with the key it already holds). The delivered writers
write the three tables in the fence's order or touch one alone, so no
delivered writer can hold a later table and wait for an earlier one; a
direct writer that does is a deadlock PostgreSQL detects, and the
re-runnable migration aborting there leaves every door intact. P42's arm
drives the drain-window interleaving under the barrier and asserts the
repair, and then starts a direct-SQL `Project` + owner/admin
`OrgMembership` pair AFTER the fence, observes both BLOCKED
(`pg_stat_activity.wait_event_type = 'Lock'`), lets the migration commit
its repair and its doors, and asserts what the doors then DO to the pair
(#564's review round 2, finding 2: the arm first claimed both would
commit, but `Project_t4d_org_readiness` and `OrgMembership_t4d_readiness`
each TRY the same org key — try-acquire-or-refuse, never a wait inside a
trigger — so whichever resumes first holds the key to commit and the other
is REFUSED): exactly ONE of the pair commits, the other is refused with
its door's message, the refused statement is RETRIED after the winner
commits and succeeds — its AFTER trigger now running under the key and
seeing the winner's committed row — and the terminal state holds the
`pmc` row, in BOTH resume orders under the barrier; the doors are not
weakened to make the pair commit together. The kernel serves them through
`platform_user_holds_role(project, user, role)`,
`platform_user_orchestration_authority(project, user)` (a `pmc` or
`architect` row), `platform_user_display_name(userId)`,
`platform_role_holder_user_ids(project, role)` (the set of users holding a
row for the role — the countersign audience, which the participant's
`effectiveRoleHolderUserIds` wraps) and `platform_membership_active_user(project,
membershipId)` (the user of a membership-granted row — the named-holder
arm) — #561's review round 2, finding 4: the audience and named-holder
arms of the NEW seals still called the orgs-owned `phase6_role_holder_user_ids`
and the delivered orgs-owned `phase6_membership_active_user`, reopening the
cycle round 1 closed; the delivered 4b/4c primitives remain for the
delivered seals only — every
seal-trigger standing read riding `phase6_try_readiness` as today — so the
decisions seals, the platform ledger and every consumer of a user's
standing read platform truth and never an orgs table; the delivered
`phase6_user_decision_authority` (4b, decisions-CREATE authority) predates
this rule, is not widened, and stays byte-identical as stated below.
**`countersignRequired` is then a KERNEL read**: the ONE
decisions read path — live and projection alike, in the hydrate step both
run — overlays `activeCount > 0` for `(projectId, 'architect')` through
`RoleStandingQuery` (one keyed lookup per response, SERIALIZED ONLY WHEN
TRUE and hydrated as false when absent — the 4c-ii consultation precedent, so
the no-chain DTO is byte-identical to today's and P29's literal byte identity
holds; the wire-shape tripwire classifies it additive-when-present),
synchronous with the membership commit whose trigger wrote it, never stored
in the projection DTO, never read from `Membership` anywhere in decisions;
the approve CAS (through `RoleStandingQuery.activeCount` in-transaction)
and every NEW DB seal (through the platform kernel's SQL read
`platform_role_standing(project, role)` over `ProjectRoleStanding`, under
the readiness lock) judge the chain by the SAME register, so the read path
and the seals cannot disagree by construction (#562's review round 1,
finding 1: an earlier sentence sent the approve CAS and the seals to the
orgs-owned `phase6_effective_role_standing`, the decisions → orgs read the
register exists to remove; that delivered primitive stays the authority
for the delivered `client`/`pmc` seals only). The `decisions.inbox` fold stores
no such field, so no fold needs refreshing when the standing changes.

**The register is not the JUDGE of any live `pmc` standing until the
fence has verified it — the WINDOW RULE** (#566's review round 2, finding
1): the race above can leave a valid membership-less owner/admin without
their `pmc` row on one project for the whole window, so a seal or read that
a window writer can meet and that resolves a user's `pmc` standing through
the fanned-out rows would REFUSE a valid actor — the delivered
`requestConsultation` passes its orgs-truth check and a re-pointed seal
refuses the insert — or DROP a valid recipient. Through the window every
such arm therefore keeps the DELIVERED orgs-truth predicate or derives the
membership-less `pmc` from the RACE-FREE registers, and the switch onto the
fanned-out rows is made by 4d-iii AFTER the fenced re-projection has proven
them equal to the orgs truth, inside the same transaction, before the doors
close. The race-free registers are `OrgUserAuthority` (org-keyed, written
by the `OrgMembership` trigger from its own row, no cross-table read),
**`ProjectOrg` (project-keyed, written by the `Project` trigger from its own
row, no cross-table read)** and the MEMBERSHIP-GRANTED rows of
`ProjectUserStanding` (a `Membership` row's
project is committed before the row can exist, by its FK); only the fan-out
of membership-less owners/admins across projects — the `Project` INSERT
reading `OrgMembership`, the `OrgMembership` INSERT reading `Project` —
races.

**`ProjectOrg` exists because the race-free derivation could not otherwise be
IMPLEMENTED by a decisions-owned seal** (#572's review round 14, finding 1).
The derivation asks for an `OrgUserAuthority` owner/admin row, and that register
is keyed by `orgId` while a decisions seal holds only the decision's
`projectId` — and no register this plan described carried the mapping. The
orgs-owned `MembershipTransition` seal has always been fine, because it reads
`Project.orgId` from its OWN module's row; every decisions-owned arm that
inherited the same derivation — the `ChangeRequest` standard requester arm, the
withdrawal closure arm, the approval revision's pair validation, and now the
frozen-role resolution of round 12's finding 3 — had no legal way to reach the
org, and a derivation that SKIPPED the join would have accepted an owner or
admin of an UNRELATED organisation as `pmc` on this project. The rule the plan
has stated since #561's round 1, finding 1 — no decisions- or platform-owned
trigger reads an orgs table — is not the obstacle; it is what made the omission
invisible, because each arm was written as though the kernel read already
carried the tenancy.

So the mapping is PROJECTED, exactly as standing and identity are:
`ProjectOrg(projectId PRIMARY KEY, orgId)`, platform-owned, written ONLY by the
generic platform primitive the orgs-owned `Project` AFTER INSERT trigger calls
from its own row, backfilled in 4d-i from `Project` and verified offline by
`platform:verify` like the others. `orgId` is IMMUTABLE — the seal refuses any
UPDATE of it, a project does not change organisation, and if that ever becomes a
product operation it is a migration with its own unit, not a silent re-tenanting
of every fact that cites the old org. The register carries the same writer-depth
seal (a depth-1 write refused, a nested write from the standing trigger
admitted), the same project-cascade arm (depth + `Project_t4d_deleting`) and a
statement-level no-TRUNCATE seal in `TRUNCATE_SEALS` as its siblings. With it,
`platform_user_orchestration_authority` and every arm taking the race-free
derivation resolve `projectId → orgId → OrgUserAuthority` INSIDE the kernel,
touching no orgs table, and the join is race-free for the reason the other two
are: both registers are written from their writer's OWN row. P29b gains the
cross-org negative — an owner of a DIFFERENT organisation, with a genuine
`OrgUserAuthority` row and no membership on this project, REFUSED by every arm
that takes the derivation, and the project's own owner admitted — RED against a
derivation with no tenancy join, which admits the stranger. Three arms meet a window writer, each disposed: **(i)** the
consultation request seal's requester arm STAYS `phase6_user_decision_authority`
through the window — 4d-i's `CREATE OR REPLACE` widens the open set alone,
and 4d-iii re-points the arm onto `platform_user_orchestration_authority`
after the re-projection (§D 4d-iii); 4d-ii's service keeps the delivered
requester check for `pmc` and admits an `architect` requester through the
kernel read `platform_user_holds_role(project, user, 'architect')` — an arm
no window request can exercise, since the reservation keeps every architect
membership unrepresentable until 4d-iii — so service and seal agree in the
window (the delivered predicate, both) and after it (the register, both) by
construction; **(ii)** the `MembershipTransition` fact's actor-role arm
(below) judges a membership-less owner/admin's `pmc` claim WITHOUT the
fanned-out row: the orgs-owned seal reads the org from its own `Project`
row and asks the race-free registers — an `OrgUserAuthority` owner/admin
row AND no membership-granted row for the actor on the project — while
every membership-granted role is the `platform_user_holds_role` register
row, the explicit-membership precedence holding in both arms; **(iii)** the
orgs participant's `effectiveRoleHolderUserIds` keeps its DELIVERED
orgs-truth SQL for `pmc` and `client` while `rollout.phase6_4d` reads
`reserved` and becomes the wrapper over `platform_role_holder_user_ids`
once it reads `open` — the ONE catalog-baked read the shell and the door
already follow, which 4d-iii flips after the re-projection — so a delivered
push in the window never omits the racing owner, and every frozen-audience
seal (all reachable only after 4d-iii) resolves the same SQL as the
service; the `architect` audience is the wrapper from 4d-ii, no architect
existing before 4d-iii, so the two implementations never coexist for a
reachable set; and **(iv)** the 4d-ii APPROVAL writer's frozen-pair
validation keeps the RACE-FREE derivation for `pmc` through the window
(#572's review round 4, finding 6). A membership-less owner/admin can
validly approve on a holder's behalf while the chain is still reserved, and
the shipped service revalidates that authority from org truth before writing
the new frozen approval pair — but in the admitted race that actor has no
fanned-out `pmc` row, so a seal reading `platform_user_holds_role` alone
would refuse the approval the service just authorised. The approval
revision's pair-validation arm therefore asks the same race-free question
arm (ii) asks — an `OrgUserAuthority` owner/admin row AND no
membership-granted row for the actor on that project — until 4d-iii
re-points it onto the register after the re-projection, so service and seal
agree in the window and after it, by construction rather than by timing.

Three arms were listed as exhaustive in round 3 and this is a fourth, which
is the same defect as finding 3 of this round in a different table: a set was
enumerated by hand. The rule these four share, stated so a fifth writer is
covered without being listed: **through the window, NOTHING a window caller
reaches — no seal that JUDGES a user's `pmc` standing and no command writer
that RESOLVES it — reads the fanned-out register** (#572's review round 12,
finding 3 widened this from "no seal" to "nothing": the register is not READY
in the window, which binds everything that reads it, and round 11 put the
frozen-pair resolution, a writer, onto it precisely because the rule named only
seals) —
each such seal or writer either keeps its delivered predicate or asks the
race-free authority derivation, and 4d-iii re-points them together after the
re-projection. An arm that cannot state which of those two it takes is a
defect in this plan. P29b's race fixture — the `Project` INSERT and the
owner/admin `OrgMembership` INSERT resumed in BOTH orders under the barrier
before the doors exist — leaves the owner WITHOUT the fanned-out row, and
then asserts: the owner's consultation request COMMITS (the delivered
predicate judges), their `MembershipTransition` with `actorRole = 'pmc'`
COMMITS (the race-free derivation judges), and a delivered `pmc` push
resolved on that project INCLUDES them; the same three after 4d-iii's
re-projection, judged through the repaired register — RED against a 4d-i
that re-points the consultation seal, a fact seal that reads the fanned-out
row alone, and a participant that wraps the register while reserved.

**The membership write that flips architect standing is a LEDGERED
TRANSITION with an immutable fact and an EMITTED event — demanded of every
writer, produced by none but the service.** The orgs-owned
`MembershipTransition(id, projectId, membershipId, fromRole, fromStatus,
toRole, toStatus, actorId, actorRole, actorName, sourceCommandId NOT NULL,
at)` fact — the frozen `actorRole`/`actorName` pair being obligation 3's
instance for the one orgs fact (#554's review round 1, finding 4): the
role THIS actor holds at the act — the actor's ACTUAL token role, judged per
user by `platform_user_holds_role(project, actor, actorRole)` against the
PRE-state register — and, for a `pmc` claim by an actor holding NO
membership-granted row on the project, by the race-free derivation the
window rule above names (an `OrgUserAuthority` owner/admin row for the org
the orgs-owned seal reads from its own `Project` row), never by the
fanned-out row alone — because the fact is inserted BEFORE the membership
write it describes, for every transition (#566's review round 1, finding
2: written membership-first, a PMC's self re-role to `engineer` had already
projected the new role before the fact claimed the frozen `pmc`, and the
live check refused the transition the plan says must succeed) (a
membership-less org owner/admin carries `pmc`; an owner/admin holding an
active non-PMC membership carries THAT membership's role — explicit-
membership precedence, exactly what their token carries) — with
team-management AUTHORITY judged SEPARATELY by the kernel read
`platform_user_manages_team(project, actor)`: a `pmc` row in
`ProjectUserStanding`, OR an owner/admin row for the project's org in the
platform-owned `OrgUserAuthority(orgId, userId, role)` register the
`OrgMembership` trigger projects (#562's review round 1, finding 2:
requiring every transition actor to hold `pmc` would have refused a valid
add, removal or re-role by an owner/admin whose token carries their
engineer membership, whom `MembersService.canManage` rightly admits) — and
the account's display name by `platform_user_display_name`,
both validated by the fact's BEFORE INSERT trigger below and immutable with
the row, so a later rename or re-role never leaves the standing change unable
to prove who acted — a
same-project composite FK to `Membership(projectId, id)` that is
`DEFERRABLE INITIALLY DEFERRED` (the fact is inserted BEFORE the membership
write for EVERY transition — on `members.add` before the row it names
exists, the service preallocating both ids, so the FK holds at commit; on a
re-role or a removal before the UPDATE — #566's review round 1, finding 2), a same-project composite FK to
`CommandExecution(projectId, id)` (immediate — the receipt is reserved before
the fact), the `(projectId, sourceCommandId)` one-use UNIQUE, EVERY column
immutable (append-only + `MembershipTransition_t4d_no_truncate`, in
`TRUNCATE_SEALS`), registered in `orgsManifest.ownsModels`/`readEncapsulated`.
**The append-only seal admits the project-deletion cascade, by the same depth
AND `Project_t4d_deleting` flag every other 4d seal on a project-scoped table
recognizes** (#572's review round 12, finding 5); a direct `DELETE` stays
refused, and the sanctioned reset keeps the named bypass below. Without that
arm the seal contradicts its own sibling one table away:
`Membership_t4d_architect_provenance` explicitly admits that cascade, and the
fact hanging off the membership refused it — so the hard delete this plan states is supported for
an event-free project would abort on the fact rather than on the row it
describes. It is REACHABLE and not merely untidy: the crossing EVENT is demanded
only of writes that flip ARCHITECT standing, so a receipt-backed non-architect
transition leaves a `MembershipTransition` row on a project holding no
`DomainEvent`, and only such a project reaches a cascade at all —
`DomainEvent.tenant` is `onDelete: Restrict`. **The sweep behind this finding is
in the round-12 audit above**, and it is what makes this the only 4d seal that
needed the arm: every other DELETE-refusing seal on a project-scoped table
either already carries it (`ProjectEventStream`, the `ProjectRoleStanding`
writer seal, the per-user registers, `Membership_t4d_architect_provenance`) or
is unreachable WITH A PROOF — `DecisionEvent`, whose every write site in the
repository emits its `DomainEvent` in the same transaction, and the 4d facts and
bound notices, which are pairing-required with their events, so a project
holding one holds events and is not hard-deletable.
`Membership` itself gains no provenance column and no pointer. The orgs-owned
`Membership_t4d_architect_provenance` seal pairs the fact BOTH WAYS on exactly
the writes that can flip architect standing: a DEFERRED constraint trigger on
`Membership` requiring, for any INSERT or UPDATE whose OLD or NEW role is
`architect`, exactly one same-transaction `MembershipTransition` row for that
membership whose `(fromRole, fromStatus, toRole, toStatus)` equals the
transition the write made (the forward-door discipline) — AT MOST ONE
standing-flipping write per membership per transaction, and at most one per
PROJECT per transaction (the service never writes two; a hand-run bundle
that does is refused rather than let two same-direction facts swap their
events); a BEFORE INSERT OR UPDATE OR DELETE trigger on `Membership` that,
whenever the write FLIPS active architect standing (`before ≠ after`,
computed from OLD/NEW exactly as the register trigger computes it), calls
`phase6_try_readiness(pid)` and refuses as contended if the key is held (the
delivered §B.1 protocol the membership guard already applies to
holder-relevant writes, which short-circuits for a plain architect INSERT
because it reduces no existing role — without it a hand-run activation would
never touch the readiness key, and an approval holding the key could observe
no architect, write `pending → approved`, and let the unblocked activation
commit first); on the fact, a BEFORE INSERT trigger calling the delivered
`phase6_t4c_provenance_reserved` (the receipt RESERVED now, of an orgs
membership command type, by the recorded actor) AND re-judging the recorded
actor's AUTHORITY at the database boundary with the service's own predicate
— `MembersService.canManage` admits the project's PMC (an active `pmc`
membership on THIS project) or an org owner/admin (`OrgMembership.role IN
('owner','admin')` for the project's org) — in TWO arms, each judged where it
can be judged truthfully (#554's review round 1, finding 6): the
owner/admin arm is read LIVE for every transition, self-targeted included,
because a project membership write changes no org standing; the project-PMC
arm and the actor-role arm are BOTH read live at the fact's insert, which
the protocol places BEFORE the membership write for every transition, so
for the actor's OWN membership (a self-transition `updateRole` permits —
the self-demotion case) the live read IS the pre-state (#566's review
round 1, finding 2: the earlier captured-`fromRole` exception covered the
PMC-authority arm only, and the actor-role arm read the row's post-state
when the membership was written first); a self-ADD (no prior row) is
admitted by the owner/admin arm alone —
so a fact whose `actorId` satisfies neither arm is refused, and an owner/admin
with an active architect membership re-roling or adding themselves passes
the seal exactly as they pass the service; paired with
the DEFERRED, TABLE-SPECIFIC `phase6_t4d_membership_transition_bound`
requiring at commit that the cited command SUCCEEDED naming
`NEW."membershipId"` as its result (the delivered `phase6_t4c_provenance_bound`
binds `resultRef = NEW.id`, which here would be the fact's own id) AND that a
same-transaction `Membership` write matching the fact exists (an orphan fact
refused); and the membership write's own BEFORE trigger requires the fact
for this exact transition to ALREADY exist in the transaction, so a hand-run
bundle that writes the membership first and the fact second is refused —
"fact first" is the sealed protocol, not a convention (#566's review round
1, finding 2). A hard DELETE of a row whose OLD role is `architect` is refused
outright except as the cascade of the project's own deletion (depth and
flag, as above) — the product removes an architect by status, and the
removal IS a transition the fact records. **The sanctioned reset keeps a
membership path** (#555's review round 1, finding 3): the seed's wipe
(`prisma/seed.ts`) hard-deletes every membership with `deleteMany` BEFORE
`project.deleteMany`, which this refusal would abort on any database holding
an active or soft-removed architect; so the seed and the fixtures' membership
wipe delete the `MembershipTransition` rows first under their append-only
seal disabled by name, then the memberships under
`Membership_t4d_architect_provenance`'s delete arm disabled by name — the
orgs standing trigger still fires and applies its deltas through the
platform primitive, nested and admitted — and the register rows fall with the
project cascade; both in the seed's existing `DO $$ … IF EXISTS (SELECT 1
FROM pg_trigger …) … DISABLE TRIGGER` protocol, re-enabled after, so a pre-4d
database resets unchanged. P28b's reset arm reseeds a database holding an
active AND a soft-removed architect and asserts the wipe succeeds with every
seal enabled afterwards, and — from 4d-iii — runs the FULL seed on the
post-4d-iii schema, fresh and mature, asserting the DL-003 plant lands
through its named bypass with every seal enabled afterwards (#564's review
round 2, finding 1), and that the seed's `changeRequest.deleteMany()` wipe
(`seed.ts:100`) succeeds through the SAME seal's named disable with the seal
enabled afterwards, while the same delete outside it is refused by the DELETE
arm (#572's review round 12, finding 1's operation sweep). **AND the crossing-capable write
must carry its EVENT** (§A.3 obligation 7, the membership instance): for
every write that flips active architect standing, the same deferred pairing
seal requires — through the platform-owned `platform_tx_event(projectId,
eventType, entityType, entityId)`, the kernel primitive that returns the
`DomainEvent` rows inserted in the CURRENT transaction (`xmin =
txid_current()::text::xid`, the conversion `20270425000000_platform_command_receipt_seal`
already uses) matching the four coordinates, the same shape as
`phase6_t4c_provenance_bound`'s read of the kernel's receipt table — exactly
ONE same-transaction `membership.standing_changed` event whose `entityId` is
the membership, whose payload `transitionId` is that fact's id, whose payload
`membershipId`, `role`, `from` and `to` equal the fact's `membershipId`,
`'architect'` (the role the fact flips — `fromRole` or `toRole`), `(fromRole,
fromStatus)` and `(toRole, toStatus)`, whose envelope `actorId`, `actorRole`
and `actorName` equal the fact's `actorId` and frozen pair, and whose
payload `activeCount` equals the register's `activeCount` for `(projectId,
'architect')` at commit — **exact because
`Membership_t4d_architect_provenance` admits AT MOST ONE standing-flipping
write per project per transaction (§A.2, the membership paragraph), so the
register's head at commit IS this event's after-count and there is no
intermediate value to disagree with** (#572's review round 20, finding 1,
declined on its mechanism and folded on this citation: the parenthetical
asserted the property and named no enforcer, so a reader looking for one found
the assertion instead. Two architect activations for one project in a single
transaction — the scenario that would let both events carry `activeCount = 2`
and be classified non-crossings — is not a valid transaction: that seal refuses
it at commit) — and refuses the write otherwise — the WHOLE event bound,
because `decisions.effects` below decides whether a crossing happened from
`role` and `to`, and a bundle that cited the real fact with `role:
'engineer'` or a non-active `to` would commit, be recorded `noop`, and leave
the newly active architect without the re-notification the fact owes (#555's
review round 2, finding 2). **And the pairing holds in the CONVERSE
direction — through a PLATFORM-OWNED generic mechanism, never a peer-owned
trigger on the kernel table** (#568's review round 1, finding 2: an earlier
text installed an orgs-owned constraint trigger on the kernel's
`DomainEvent` that read `MembershipTransition`, and §A.3 repeated the shape
for the decisions types — the leaf event store executing application-module
persistence logic on its write path, the dependency direction inverted).
The kernel owns a `DomainEventPairingClaim(projectId, eventId, ownerModule,
factTable, factId)` register, UNIQUE per `eventId`, append-only and
non-truncatable (`TRUNCATE_SEALS` gains it), written ONLY through the
platform primitive `platform_claim_event_pairing(eventId, ownerModule,
factTable, factId)` at trigger depth — a direct write and a statement-depth
call are refused, the writer-depth seal of the standing registers; every
persisted catalog row carries `pairingRequired` (seeded from the compiled
`EXTERNAL_EFFECTS` under the tripwire: TRUE for `membership.standing_changed`
and every sealed decisions type the §A.3 table lists, FALSE for
`decision.published` and every other announcement family); and the kernel's
OWN DEFERRED constraint trigger `DomainEvent_t4d_pairing_claimed` requires
at commit, for every event whose catalog row is `pairingRequired`, exactly
ONE same-transaction claim naming it — reading nothing but platform tables.
**EXACTLY ONE claimant per event, named per branch** (#572's review round
4, finding 5). The register is UNIQUE per event and the kernel refuses an
unclaimed `pairingRequired` event, so "every fact seal claims its events"
breaks at both ends: a branch whose only same-transaction fact is an AUDIT
row (the `countersign_renotified` re-emitted demand) named no claimant and
would abort with the event unclaimed, while a BUNDLE whose facts share one
event (the returned resolution; a reapproval) would have two seals claim it
and abort on the UNIQUE. The rule is therefore stated per branch, not per
seal: **the branch's PRIMARY fact claims, and every other fact in the bundle
is verification-only** — it verifies the event through `platform_tx_event`
and does not claim it. **Which fact is primary is DERIVED, not listed**
(#572's review round 9, finding 1). The list this paragraph used to carry
named `decisions.disagree`, `resolveStrandedCountersign` and the
re-notification branch — while the sentence four lines above it identified
the REAPPROVAL as a fourth bundle sharing one event, and never named its
claimant. A hand list of primaries is the same defect round 6 replaced with
a derived writer set and round 8 replaced with a derived obligation set,
arriving a third time in a third place.

The primary is **the fact present on EVERY instance of the branch** — the
one whose absence would mean the transition did not happen. That is forced
rather than preferred: a fact written on only SOME arms cannot be the
claimant, because the other arm's event would then be unclaimed and the
kernel would abort it. It settles the reapproval — the direct approve writes
its `DecisionApprovalRevision` from `pending` and from `change` alike, while
the `ChangeRequest` CLOSURE exists only on the `change` arm, so the REVISION
claims and the closure verifies — and it reproduces every primary the list
had named by hand: the reject-back/forward-on REQUEST (both disagreement
shapes write one), the RESOLUTION row (both outcomes write one, while its
`ChangeRequest` exists only on `returned`), and the re-notification's audit
row (its only fact). The correspondence table below carries the claimant in
its own column for every transition this unit seals, so a branch added
without one is VISIBLE in the table rather than trusted to a promise — and
that table is closed over the pairing-required decisions types by
construction, since `pairingRequired` is seeded from exactly the types it
lists. P29b/P37 assert both failure shapes: an unclaimed event aborts, and a
doubly-claimed one aborts.

The OWNER supplies the claim: the orgs-owned `MembershipTransition` seal,
having verified its event through `platform_tx_event` (the fact-side arm
above — the payload's `transitionId` the fact's id, the `entityId` the
fact's `membershipId`), claims it; so a standalone catalog-valid crossing
event with no fact — a fabricated re-notification — has no claim and is
refused by the kernel; a claim without its fact is unrepresentable (the
primitive runs only inside the owner's fact trigger); two facts claiming one
event are refused by the UNIQUE. Obligation 7 applies the same mechanism
to every sealed decision event type — every arm this plan attributes to
"the converse" is an arm of the CLAIMING fact seal, the owner's trigger on
its own table reading the event through the kernel's
`platform_tx_event`/`platform_event` contracts, and the kernel demands only
the claim. The three orgs membership
mutations that can touch an architect — `members.add` (re-activation of a
removed member goes through it), `members.updateRole`, `members.remove` —
become COMMANDS on the ledger in 4d-ii, each writing its
`MembershipTransition` row and, on a standing flip, emitting
`membership.standing_changed` `{ role: 'architect', membershipId,
transitionId, from: { role, status }, to: { role, status }, activeCount }`
(project-scoped, `invalidate: true`, no push, in both catalogs and
`orgsManifest.producesEvents`) through the ordinary `emitEvent` after the
write, reading `activeCount` through `RoleStandingQuery` under the readiness
lock it already holds; `executeCommand` with an idempotency key and
`resultRef` = the membership id, the routes and the web store carrying the
key, the §A command-level readiness-lock enumeration gaining all three — and
ALL THREE opting into server key synthesis (`synthesizeKeyWhenAbsent:
true`), because 4d-ii-a lands while deployed browser tabs are open and those
tabs call the member POST/PATCH/DELETE routes with NO `Idempotency-Key`
(`apps/web/src/data/apiGateway.ts` — `addMember`, `updateMemberRole`,
`removeMember`); under the documented default (`COMMAND_KEY_ENFORCED`
unset) `executeCommand` would take its ledger-less branch with a null
`commandId`, and the `MembershipTransition` insert — `sourceCommandId`
NOT NULL, FK-bound to the receipt — would roll back an ordinary
non-architect add, re-role or removal that the current API accepts, which
is exactly the "dark" claim above failing. The client key ships in the
CLIENT unit 4d-ii-b and cannot repair a tab opened before it; synthesis is
the same delivered answer `requestChange` takes (#572's review round 1,
finding 2) and changes nothing else — an unkeyed call reserves a per-call
server key and runs once, a keyed call replays exactly once, enforcement
refuses a missing key before synthesis is considered (#572's review round
3, finding 4; P29b's no-header arms). They
are not commands today (`members.service.ts` takes `lockProjectReadiness`
and writes no receipt; `worker-devices.service.ts` is the orgs precedent for
the ledger). The trust boundary is the ledger's own, stated where the
platform seals it (`20270425000000_platform_command_receipt_seal`: no
trigger can distinguish the application from SQL that reproduces the
protocol by hand — reserve, write, complete, in one transaction) — and THAT
is why the event is demanded at the boundary rather than produced there: an
architect B written by hand-run SQL under a hand-completed receipt after A
left either carries its `membership.standing_changed` event, in which case
every tab refreshes and the re-notification below runs exactly as for the
service path, or it does not commit. **The alternate `Membership` writers
are enumerated, and none can mint the role** (#556's review round 1,
finding 1): outside `members.service` (a command from 4d-ii) the repository
writes `Membership` rows from exactly four places — the sign-in provisioning
in `auth.service.ts` (hard-coded `engineer`), project creation in
`orgs.service.ts` (the creator as `pmc`), `prisma/seed.ts` (the demo roles
of `seed-data.ts`, which name no architect — the provenance seal refuses one
if they ever do, loudly, on a wipe-and-reload database), and
`prisma/ensure-accounts.ts` — the manual `ensure-accounts` command and the
`AUTO_ENSURE_ACCOUNTS=true` boot path — which creates a `User` from an
`ACCOUNTS_JSON` entry and then upserts its `Membership` directly, and whose
backfill creates a membership from a legacy `User.role`. An entry with
`role: "architect"` would pass the User write and be refused at the
membership, failing provisioning with the user left behind. 4d-ii therefore
makes `ensure-accounts` VALIDATE the whole `ACCOUNTS_JSON` before its first
write and refuse an `architect` entry — and an `architect` `User.role` in
the backfill — with a named error and no partial write: architect standing
is a product act of the PMC through the ledgered commands, never a
provisioning default (the same reading 4d-iii gives chain activation: "a
per-project product act by the PMC, never a database default"). P28b's
arm: an `ACCOUNTS_JSON` holding a `pmc` and an `architect` entry is refused
before any row is written (no `User`, no `Membership` for either), the
`pmc`-only file provisions, and a boot with `AUTO_ENSURE_ACCOUNTS=true` over
the refused file fails closed naming the entry. `architect` is thereby OUTSIDE the
direct-writer set: a direct architect write is REFUSED (hostile probes under
P29b: INSERT, role UPDATE into and out of `architect`, soft removal, restore
— each without a transition fact refused at commit, each with a fact citing
no receipt refused, each with a fact whose receipt never completed refused
at commit, each with a receipt borrowed from another command type or actor
refused, a fact whose `(from, to)` disagrees with the write refused, an
orphan fact refused, a crossing write with NO same-transaction event
refused, with an event naming another membership or another fact refused,
with a payload `activeCount` that disagrees with the register refused, with
a payload `role`, `membershipId`, `from` or `to` that disagrees with the fact
refused (the `role: 'engineer'` and non-active-`to` bundles of #555's
review round 2 in particular), with an envelope actor or frozen pair that
is not the fact's refused, a standalone `membership.standing_changed` event
with no same-transaction fact refused at commit, two events for one fact
refused, two flips of one membership in one transaction refused; a hard DELETE refused;
the fact UPDATEd, DELETEd or TRUNCATEd refused; a direct write to the
register refused, the register erased by DELETE or by TRUNCATE refused,
`Membership` truncated refused; each through the service succeeding, the
register moving by exactly one in the same commit with the event emitted;
the hand-run bundle reproducing receipt + fact + write + event succeeding
with the SAME refresh and re-notification). The event fires on EVERY
activation or deactivation of an architect membership, crossing or not: a
1 → 2 activation invalidates open tabs harmlessly (duplicate invalidations
are idempotent by the socket consumer's contract) and its consumer below
classifies it a recorded no-op. The project that CAN be hard-deleted is an
EVENT-FREE one (`DomainEvent.tenant` references `Project` with `onDelete:
Restrict`, so a project that ever emitted holds its committed events and its
hard delete is refused at that FK before any cascade runs; the supported path
for a live project is `archive`); the cascade probe deletes an event-free
project with memberships but no architect ever active and asserts the delete
succeeds with no delta and no register row left — **and does it on a project
that HOLDS `MembershipTransition` rows**, which is the case the append-only
seal used to abort (#572's review round 12, finding 5): a receipt-backed
non-architect transition leaves a fact without a `DomainEvent`, because the
crossing event is demanded only of writes that flip architect standing, so an
event-free project can carry facts and only an event-free project ever reaches
a cascade at all — AND hard-deletes a project
holding an active architect and asserts the delete is REFUSED by the tenant
FK with the event, the fact and the register row intact.

**OTHER OPEN TABS learn the standing changed**: a client that loaded a
`pending` decision before the first architect was added holds
`countersignRequired` absent in its store, and the delivered membership
events are catalogued `invalidate: false`, so without this event no socket
`changed` would reach that tab and it could open the approval modal
promising a final lock while the server lands `awaiting_countersign`.
`membership.standing_changed` is `invalidate: true`; the external-effect
dispatcher turns it into the ordinary per-project socket `changed`, every
open tab on the project refetches, and its next read carries the kernel
overlay. P29b's arm: two sessions, the second holding a loaded `pending`
decision; the first adds the first architect → the second receives
`changed`, refetches, and its modal reads the countersign copy; the same with
the architect written by a HAND-RUN bundle — the event still emitted, the tab
still refreshed, the re-notification still delivered.

**The re-notification and the last-architect cancellation are DERIVED from
the event by a decisions-owned ORDERED consumer, `decisions.effects`**,
registered beside `decisions.inbox` — INACTIVE by 4d-ii's catalog-data
migration, ACTIVATED by 4d-iii's appended `OutboxConsumerActivation` row
once the fleet is drained, since a still-serving pre-4d-ii process writes
no row for a consumer it does not know and the delivery seal requires a
row for every ACTIVE consumer (#560's review round 1, findings 1 and 6) —
with `decisionsManifest.consumesEvents`
gaining `membership.standing_changed` (the second non-empty
`consumesEvents` in the registry after labour's; the ordered-consumer
delivery-count pins advance). Its persisted rule is `types` over exactly
`membership.standing_changed`, so every event of that type is a `dispatch`
row and every other type a `noop` row by rule; the HANDLER judges the
payload — an `architect`-role CROSSING, `activeCount = 0` with `to` not an
active architect (deactivation) or `activeCount = 1` with `to` an active
architect (activation), acts, and a non-crossing of the type is handled as
a recorded no-op; history is a recorded no-op the same way (the type is
new, so no historical event of it exists; at activation the relay's
`expandMissingDeliveries` gives the consumer a `noop` row per historical
event of every other type from that persisted rule, bounded and one-time,
and P38's activation arm asserts a database holding historical events
activates the consumer with every historical delivery `succeeded`/`noop`,
zero notifications and zero `countersign_renotified` rows). Both handlers
run under `lockProjectReadiness` in the handler transaction — serializing
with `approve`, the stranded resolution and every standing write — and both
decide PER DECISION from stream positions the kernel already holds, through a
platform-owned `EventStreamQuery.latestPosition(tx, projectId, eventType,
entityType, entityId)` (the highest `streamPosition` of an event of that type
about that entity in the project — a kernel query over the kernel's event
store, no module table read): for each of the project's
`awaiting_countersign` decisions (own table, under the decision row lock,
taken AFTER the decision's `countersign` delivery rows are locked `FOR
UPDATE` in ascending id order — the ONE lock order below), let `demand` be
the latest position of a `decision.awaiting_countersign` event about it;
**if `demand` is later than this crossing's position, the decision is
SKIPPED** — its demand was raised against a standing at or after this
crossing, by an approve or a later re-emit that resolved the current
architects itself; **otherwise** the handler cancels by subject every
not-yet-sent `countersign` delivery of the decision (the delivered
`cancelQueuedPushBySubject`, a demand raised before the crossing being
addressed by construction to architects who are ALL gone at a deactivation,
or all departed before an activation from zero) and, for an ACTIVATION,
re-emits `decision.awaiting_countersign` — the same catalog entry, family and
body, payload `{ renotified: true }`, recipients frozen at emission as every
countersign demand's are — for that decision, appending a
`countersign_renotified` `DecisionEvent` attributed to the envelope's system
actor `system:membership-standing` with the crossing event's id and
`transitionId` in its payload (the human act is recoverable by an auditor
from the immutable `MembershipTransition` fact the event names — never
derived by the consumer, which could pick the wrong transition when a
membership is removed and restored more than once before the handler runs);
for a DEACTIVATION it re-emits nothing (the demand is gone until the chain
reactivates). **An ACTIVATION the standing has already reversed is a
recorded no-op** (#556's review round 2, finding 1): before re-emitting, the
activation handler judges the CURRENT standing under the readiness lock it
holds — the register's `activeCount` for `(projectId, 'architect')` through
`RoleStandingQuery` — and when it is ZERO (architect B activated at Q and
was removed again at R before the consumer reached Q) it records Q `noop`
with reason `stale_activation`, emits nothing and cancels nothing: the
deactivation R, later in the same ordered stream, is handled next and
cancels every unsent pre-Q demand exactly as a deactivation does. The
correspondence seal's refusal of an EMPTY frozen audience is therefore a
seal no handler ever reaches, and an ordered consumer can never dead-letter
on a crossing the standing has since reversed. When the current count is
non-zero the handler re-emits to the CURRENT holders (never to the set at
Q): for Q → R → S (B removed, C added, all before Q is handled) the Q
handler's re-emit freezes C at a position beyond S, so the S handler finds
`demand` later than S and skips — exactly one fresh demand, to the
architect who holds the role, whatever the backlog. Exactly once, never twice, whatever the interleaving: the
handlers are ORDERED, so the deactivation at P is handled before the
activation at Q; an approve committing after Q targets the current
architects itself and its `demand` exceeds Q, so the Q handler skips it; a
decision awaiting from before P has its pre-P demand cancelled at P (unsent)
or already sent to the departed architect, and receives ONE fresh demand at
Q; a decision approved to finality under NO chain before P is not awaiting,
is enumerated by nothing and owes nothing; an activation while another
architect is already active is not a crossing and emits nothing; the
unordered `webpush.notify` worker only SENDS, never creates deliveries, and
the one race between its send and the handler's cancellation is resolved by
the delivery row lock and the final pre-send re-read below. The handler is
keyed per (decision, event) so a redelivery appends nothing; P36's ordering
barrier asserts the exact count per decision in both directions and P29b
drives approve → A removed → B added, through the service and through the
hand-run bundle, asserting exactly one new `decision.awaiting_countersign`
delivery per still-awaiting decision and that B, and only B, receives it.
This consumer is NOT a projection: `decisions.inbox` stays recompute-only,
and a projection rebuild replays nothing into `decisions.effects`, whose
cursor is its own. Preserving the cancelled delivery instead was weighed and
not taken: the cancellation mark is terminal by 4a's design and an
un-claimable "no recipient yet" delivery would retry to dead-letter.

#### The stranded decision, resolved by a NAMED command

The concrete interleaving: approve → `awaiting_countersign` → the last
architect leaves; generic forwarding refuses that status and countersign
needs an architect, so without a defined command the decision is gate-`wait`
forever. The PMC-only `decisions.resolveStrandedCountersign` is legal ONLY
while `status = 'awaiting_countersign'` AND no active architect membership
exists (both re-checked under the decision row lock + `lockProjectReadiness`
— the switch serialization of P36 covers an architect re-appearing
mid-command), with two explicit attributed outcomes recorded as a REGISTER
FACT: the append-only `DecisionStrandedResolution` table (`projectId`,
`decisionId`, the exact head `revisionId` resolved, `outcome: 'completed' |
'returned'`, `resolvedById` + frozen `resolvedByName` + frozen
`resolvedByRole`, `reason` with the non-blank discipline, `at`, the
provenance shape; same-project composite FKs; immutable; UNIQUE per
`(projectId, decisionId, revisionId)` — a decision re-stranded on a LATER
revision resolves again, the same revision never twice). **(a) COMPLETE
under the no-chain rule** — the head revision's `finalized` flips true and
the decision moves to `approved` in the SAME transaction as the resolution
row with outcome `'completed'`, the service emitting the real finalizing
event — `decision.approved` or `decision.reapproved` by the revision's
recorded `approvedFrom` (below). **(b) RETURN to the decider** — the decision
moves to `change` with a same-transaction open `ChangeRequest` carrying
origin `countersign_rejection` and the PMC's reason, its `requestedById` the
PMC who resolved (the rejection request has TWO legal producers, the
architect's disagreement under an ACTIVE chain and the PMC's stranded return
under an INACTIVE one, and its seal discriminates them by the fact it is
paired with — §B.6), paired with the resolution row with outcome
`'returned'`, so the existing machinery demands a fresh approval (which,
under the now-INACTIVE chain, lands `approved` directly) and the closed
`withdrawChange` escape stays closed. The reverse holds with the BUNDLE
named exactly: a `DecisionStrandedResolution` INSERT commits only with its
matching same-transaction bundle — outcome `'completed'` with the finality
flip AND `awaiting_countersign → approved`; outcome `'returned'` with
`awaiting_countersign → change` AND the same-transaction open
`ChangeRequest` carrying origin `countersign_rejection` (the transition alone
is NOT enough: a returned-resolution insert without the request would commit
a `change` decision whose reason no reader can see and which neither
`approve` nor `withdrawChange` can close, since both require exactly one
open request — `ChangeRequest_one_open_per_decision`). Neither outcome
touches `pending`. **A designation WITHOUT an active holder is re-homed
atomically** (#566's review round 2, finding 2): `returned` for a decision
whose INSTALLED designation has no active holder — the NAMED membership
departed, OR the ROLE designation holds zero active members
(`platform_role_has_holder(project, role)` false: the architect role after
its sole member, who approved the decision, left under the exemption below;
a `client`/`pmc` role designation emptied the same way) — REQUIRES a
same-command `toDesignation`, and the resolution bundle carries a
`DecisionForward` row FROM that empty designation (the departed membership,
or the role) to the named ACTIVE target, actor the resolving PMC, reason
the resolution's, so the decision lands in `change` with an active holder
and never trips the open-holder rule — which judges a `change` decision's
designation, named or role, for an active holder at commit, and would
otherwise refuse the very transition this outcome advertises; a `returned`
without a target for such a designation is 400, and a `returned` WITH a
target for a designation that still has an active holder is an ordinary
same-bundle forward through the same door (the `countersign_rejection`
request the bundle carries is the one that door admits); the bundle-aware
provenance binds the third fact to the same receipt. Probed end to end in
P29b: both outcomes, the refusal while an architect is still active, the
architect-reappears race, the missing-request hostile bundle, the departed
holder's re-homing, the emptied role designation's re-homing.

#### Countersign, and the state that carries it

Under an active chain, the decider's approval writes its
`DecisionApprovalRevision` (bound, as 4c delivered it, to the completed
`decisions.approve` receipt) and moves the decision to
**`awaiting_countersign`** — the third and last new `DecisionStatus` value,
riding the enum for the reason `withdrawn` and `recorded` did — emitting
exactly ONE event, `decision.awaiting_countersign` (the countersign demand:
its payload the provisional act — `approvedFrom`, the option, the approver's
frozen name and role — and its dispatch intent the architects frozen as
`targetUserIds`), and NEVER `decision.approved`/`reapproved`, which announces
FINALITY to every consumer (the `decisions.inbox` fold, the approval push,
the readiness gate) and is the finalizer's to emit (#554's review round 1,
finding 1 — obligation 7 requires the demand event at this transition and
refuses an approval event there); the delivered `decision_t4b_attribution_seal`
admits the transition through the two clauses 4d-i widens for it (§A.2
forwarding). **The readers
that do NOT fail to compile are enumerated**, because the compiler catches
only exhaustive switches: `StatusChip.tsx` casts `decisionChip` /
`decisionChipLabel` through `Record<string, …>` and FALLS BACK to the
withdrawn styling — 4d-ii adds explicit `awaiting_countersign` entries to
both maps in `packages/shared/src/tokens/colors.ts`; `deriveDecisionReading`
(`packages/shared/src/domain/readiness.ts`) has a catch-all that describes an
unknown status as awaiting the existing DECIDER's approval — 4d-ii adds the
explicit arm (`wait`, "Approved by <decider noun> — awaiting the architect's
countersign"); `apps/api/src/domain/transitions.ts` carries a lagging
duplicate `DecisionStatus` union that already lacks `recorded` and
`apps/api/src/snapshot/types.ts` a string union of its own — 4d-ii points
both at the shared type; the web audience selectors (`selectors.ts`),
`DecisionLogScreen.tsx` (its filter list, `neverLocked`, the withdrawn-reason
block) and the `ScheduleScreen.tsx` filter each answer for the value
explicitly; `ConsultationThread.tsx` computes its open set as
`pending`/`change` — 4d-ii widens it with `awaiting_countersign` AND loads
the roster the chooser draws from (`ConsultationThread` derives its askable
set from the store's `members`, filled only by `loadTeam()`; on a fresh
architect session the widened Ask would open an EMPTY chooser, so the
consultation surface calls `loadTeam()` when `members` is empty, exactly as
`IssueDecisionModal` does, under the `members.read` row §A.1 gives the role);
`lib/locationTree.ts` keys its per-status counters, its `STATUS_LABEL` and
its status-mode rank by literal status — 4d-ii adds the counter, the label
"Awaiting countersign" and the rank between `change` and `approved`. A
shared TRIPWIRE pins the CLASS: a test walks every `DecisionStatus` value
against EVERY status-keyed map and predicate in shared and web — each
registered in the test so a map added later has to be registered too —
asserting an explicit key or arm for every value, RED for
`awaiting_countersign` the moment the enum value exists. Walking the 4a
§A.3 reader table: gate `wait` — work must not start on an uncountersigned
approval; pending surfaces show it to the ARCHITECT as their action item —
including the Inbox: `selectActionItems` (`store/selectors.ts`) derives
decision work from `pending` and `change` rows alone, so 4d-ii adds the
`awaiting_countersign` branch (the active ARCHITECT's "N decision(s)
awaiting your countersign" item, the PMC's "awaiting the architect's
countersign" summary, and when the chain is INACTIVE the PMC's red
stranded-resolution item) and the selector joins the reader tripwire; the
architect's Decision Log controls (Countersign / Reject back / Forward on)
render for an active architect on an awaiting decision and are probed as a
product path; withdraw refuses it — an approval act exists, which the
delivered `phase6_t4a_no_approval_after_withdraw` seal also enforces. **The
consultation carve-out widens WITH the status** (the 4c hand-off):
`awaiting_countersign` joins the open set in the service predicates AND in
both delivered 4c seal functions (`phase6_t4c_consultation_request_seal`,
`phase6_t4c_consultation_response_seal` — `CREATE OR REPLACE` in 4d-i with
the widened open set, the bodies otherwise byte-identical; the request
seal's requester arm STAYS on `phase6_user_decision_authority` through the
drain window and is re-pointed onto `platform_user_orchestration_authority`
by 4d-iii after the fenced re-projection — the window rule of §A.2, #566's
review round 2, finding 1: re-pointed in 4d-i, the seal would have refused
the request of a membership-less owner/admin whose `pmc` row the window
race lost, an owner the delivered service admits — while 4d-ii's service
admits the `architect` requester through the kernel read, an arm nothing
can exercise before 4d-iii), so an architect — representable only after
4d-iii — may consult on the very approval they must countersign. **The RESPONSE push follows the widened
requester set**: the delivered `consultationRespondedPushTarget` accepts
requester standing for `['pmc']` only and carries no status arm, because a
withdrawn decision is pmc-only and a PMC may still be told advice was given;
4d-ii widens the standing arm to `['pmc', 'architect']` AND adds the
audience arm the omission relied on — a response push whose requester is NOT
pmc is cancelled with the recorded mark when the decision is `withdrawn`,
while a PMC requester keeps today's behaviour byte-for-byte (P38). **And the
intent records the audience the send reaches** (#557's review round 1,
finding 2): the delivered emitter persists `roles: ['pmc']` on every
response push and the `decision.consultation_responded` catalog ceiling is
`['pmc']`, so widening the predicate alone would either send to an
architect under an intent that records a PMC audience or, if the emitter
told the truth, abort at `buildDispatchIntent`; 4d-ii's catalog widening
therefore includes this event (ceiling `['pmc', 'architect']`, the same
coverage-version bump as the two new families) and the `respond` emitter
persists the requester's ACTUAL role — read from the consultation row's
FROZEN `requestedByRole`, `pmc` or `architect` — so the immutable intent and
the claim-time predicate agree. **That role is a column on the fact, not a
resolution at response time** (#557's review round 2, finding 4: the
delivered `DecisionConsultation` records `requestedById` and no role, and a
role resolved when the response arrives is not the role at the request for
a requester who has since changed roles or holds both): 4d-i adds the
nullable frozen `DecisionConsultation.requestedByRole`/`requestedByName`
pair AND the nullable frozen
`DecisionConsultationResponse.respondedByRole`/`respondedByName` pair
(#561's review round 2, finding 8: with only the requester's role frozen, a
hand-run request or response could pair the real actor id with an
arbitrary envelope name or role and nothing on the fact could refute it),
all four frozen with their rows by the delivered consultation seals (NULL
only on legacy and drain-window rows — a legacy request only a `pmc` could
have made, so a NULL role reads as `pmc` — and a trailing 4d-iii arm
requires all four on every new row); 4d-ii's `consultation.request` writes
the requester's role and name and `consultation.respond` the responder's,
each INSERT seal judging the pair under obligation 3 against the platform
registers (a role the actor does not hold or a name that is not the
account's is refused), and each consultation event's envelope binds
`actorRole`/`actorName` to its fact's pair exactly as every 4d fact's does;
the `respond` emitter reads the frozen requester role and binds the
response intent's `roles` to it. P38's arm asserts an architect requester's response push carries
`roles: ['architect']`, a PMC requester's is byte-identical to today's, and
a requester re-roled between request and response is pushed under the
request-time role.

**The cycle semantics DO need a new rule, and it is the finality flag**
(#572's review round 15, finding 3). The delivered cycle is a revision COUNT —
`decisionApprovalRevision.count({ where: { decisionId } })`, frozen into
`openCycle` at `decisions.service.ts:638` and compared at `:765` — and 4d
breaks that count in both directions, because it introduces a revision that is
inserted without approving anything and an approval that appends no revision:

- **A consultation requested while `awaiting_countersign` is answerable again
  after the decision reopens.** Its `openCycle` includes the provisional
  revision; the countersign only flips `finalized` and appends nothing, so the
  count does not move; a later standard `requestChange` reopens the decision to
  `change`, which IS in the open set, and the delivered predicate finds the
  count still equal — so a question closed by an approval that already happened
  is live again in the NEXT cycle. The paragraph this replaces asserted the
  opposite ("stays cycle-valid until the decision leaves the open set") and
  reasoned only about the countersign, never about what comes after it.
- **The inverse fails too.** A consultation requested while `pending` freezes
  `openCycle` at the pre-approval count; the provisional approval then INSERTS
  its unfinalized revision and the count moves — so the question is cycle-dead
  the instant the decision enters `awaiting_countersign`, although 4d widens the
  open set to include that state and DELIBERATELY leaves the request push
  uncancelled. The consultee is pushed a question the service will refuse.

So the cycle counts FINALIZED approvals — `count({ where: { decisionId,
finalized: true } })` — at EVERY producer and EVERY reader, which must move
together (#572's review round 16, finding 3; round 15 changed two of them and
called the rule discharged, which is the trace this table now carries):

| site | role in the rule | disposition |
| --- | --- | --- |
| `decisions.service.ts:638` | PRODUCER — freezes `openCycle` at request | finalized-only |
| `decisions.service.ts:764` | ENFORCEMENT — the response predicate | finalized-only |
| `decisions.query.ts:348` | ENFORCEMENT — the claim-time push predicate, re-read under the delivery lock | finalized-only |
| `decision-serialize.ts:96` | PRODUCER — `approvalCycle` on the DTO | finalized-only |
| `decisions.query.ts:203` | the PROJECTION carries `approvalCycle` into its fold | recomputed from the same rule; the REBUILD must agree, and a pre-4d-ii relay writing the old meaning is the #571 round-4 finding-3 shape — the projection's own version guard is what keeps it out |
| `packages/shared/src/domain/decider.ts:57` `viewerIsConsultee` | CONSUMER — compares `c.openCycle` with the current cycle | code unchanged; its INPUT is the DTO field above, so it moves with it on BOTH sides |
| `decision-serialize.ts:176` | CONSUMER — SERVER-side decision visibility | via `viewerIsConsultee` |
| `apps/web/src/store/selectors.ts:57` and `:83` | CONSUMER — CLIENT-side decision visibility | via the DTO field; server and client must compute the same number or the `ui-server-parity` invariant breaks |
| `apps/web/src/components/ConsultationThread.tsx:47` | CONSUMER — the response control | via the DTO field |

**The consequence is larger than a hidden control.** `viewerIsConsultee` gates
VISIBILITY, not just the button: with `openCycle` finalized-only and
`approvalCycle` still a total, a consultee stops seeing the decision at all
while it sits in `awaiting_countersign` — on the client, through
`selectors.ts`, and on the server, through `decision-serialize.ts:176` — while
the corrected API predicate would accept their answer. That is a server/client
parity break as well as a lost affordance.

**And TWO revision counts in the same service must NOT move, which is why
"convert every count" is the wrong instruction and this table names roles
instead.** `decisions.service.ts:1147` counts revisions to refuse withdrawing a
decision that carries approval evidence — a PROVISIONAL approval IS approval
evidence, and a decision awaiting countersign must not become withdrawable, so
that count stays total; converting it would destroy a countersign in flight.
`decisions.service.ts:511`'s `priorApprovals` counts `DecisionEvent` rows, not
revisions, and allocates the next version — every revision occupies a version
whether or not it is finalized, so it is untouched by this rule and protected by
round 13's own INSERT converse. Both are enumerated here so a later reader does
not "finish the sweep" by breaking them. Then the provisional insert does not move
the cycle (nothing has been approved), the countersign's flip does (something
has), and a reopen does not resurrect a question the approval closed. All four
paths hold: requested-while-pending survives into `awaiting_countersign`;
requested-while-awaiting closes at the countersign; neither is answerable after
a reopen; and an unchained approval closes its cycle exactly as 4c's P25d
proves, because outside a chain the row is born `finalized = true`. **Legacy
data needs no migration**: 4d's additive backfill leaves every pre-existing
revision `finalized = true`, so for every decision that predates the chain the
finalized count EQUALS the total count and every `openCycle` frozen before 4d
keeps the meaning it was written with. P25d gains both sequences — request
before provisional approval, answered after the countersign-widened open set
admits it; and request while awaiting, refused after the countersign and
refused again after a `requestChange` reopen — RED against the count-all rule,
which fails the first and admits the second. **And it proves the READERS, not
only the API** (#572's review round 16, finding 3): in the first sequence the
consultee's DTO carries the decision with `approvalCycle` equal to their
`openCycle` while it sits in `awaiting_countersign`, `viewerIsConsultee` returns
true on BOTH sides, the decision is present in the client's own selector output
and the response control is rendered, and the claim-time push predicate at
`decisions.query.ts:348` still finds the standing consultation — each RED
against a reader left on the total count, where the consultee loses the decision
from view and the delivery is dropped while the API would accept the answer. The
two counts that must NOT move are asserted too: a decision awaiting countersign
stays UNWITHDRAWABLE, and the next approval's version is unchanged.

**A provisional approval must not be TRUSTABLE as a final one**: the
register is a provenance TARGET, so the row carries `finalized` — born `true`
outside a chain (today's behaviour byte-identical), born `false` under a
chain, flipped `true` by the countersign as its ONE permitted transition,
trigger-sealed. **The countersign fact is a ROW, not a boolean**: the
second register act is a concrete append-only `DecisionCountersign` table
(`projectId`, `decisionId`, the exact `revisionId` countersigned,
`countersignedById` + frozen `countersignedByName` + frozen
`countersignedByRole`, `at`, the provenance shape; composite FKs
same-project; immutable), UNIQUE `(projectId, decisionId, revisionId)`, and
the `finalized` false→true flip is trigger-PAIRED to a same-transaction
pairing fact for that exact revision — the `DecisionCountersign` row (the
chain path), or the `DecisionStrandedResolution` row with outcome
`'completed'` (the ONLY other legal finalizer). A finalized-only flip with
NEITHER fact is unrepresentable (P31). **The delivered append-only seal is
REPLACED, never stacked under**: the register carries
`DecisionApprovalRevision_append_only` (`phase3_immutable_row()`), which
rejects EVERY UPDATE, so the paired flip would abort before the pairing
trigger judged it; 4d-i DROPS that trigger in the same transaction that
installs the register's own replacement — a BEFORE UPDATE OR DELETE seal that
refuses every DELETE and admits an UPDATE only when the SOLE change is
`finalized` false→true (every other column compared OLD to NEW and frozen; a
true→false or true→true write refused), the pairing judged by the DEFERRED
trigger of §B.4. The old trigger ABSENT and the replacement PRESENT by name
join 4d-i's closing verification and `upgrade-proof.sh`, where the legacy
fixture's rows (all `finalized = true`) stay byte-identical. **The BIRTH
value is sealed too**: a BEFORE INSERT seal on `DecisionApprovalRevision`
judges the born value by chain presence under `phase6_try_readiness` — with
an active architect chain a revision is BORN `false`; with no active chain,
born `true` — and requires the new row's `version` to be the decision's
next; the forged-birth hostile insert is probed (P31, with P42's provenance
arm). **The ENTRY into `awaiting_countersign` is sealed from the DECISION
side**: the approved-entry trigger's BEFORE UPDATE arm also judges every
transition INTO `awaiting_countersign` — legal only FROM `pending`/`change`
and only under an ACTIVE chain — its BEFORE INSERT arm refuses a decision
BORN `awaiting_countersign` outright (#567's review round 2, finding 2:
after 4d-iii drops `Decision_t4d_awaiting_reserved`, a direct INSERT of a
published row already carrying the status would have passed the delivered
4b INSERT seal, which judges publication and holder standing, and committed
with no provisional revision, receipt, demand event, audit row or notice —
a head the countersign and the stranded resolution could never finalize;
the state is ENTERED only through the sealed transition, never born, and
the seed plants no such row) — and a DEFERRED pairing requires at commit
that the decision's HEAD revision is the provisional approval this
transition recorded: `finalized = false`, `approvedFrom` equal to the status
the transition left, citing a COMPLETED `decisions.approve` receipt naming
this decision, and UNDISPOSED — named by no `countersign_rejection`
`ChangeRequest` and no `DecisionStrandedResolution`, both of which record the
exact `revisionId` they disposed of (the rejection request therefore carries
`revisionId` — NOT NULL for `countersign_rejection`, NULL for standard rows,
CHECK-pinned, frozen with the rest of its evidence), so a rejected or
returned head can never be re-entered by a bare status flip while the real
re-approval appends a FRESH head that passes. **The countersign is
ATOMIC**: a DEFERRED reverse seal refuses a `DecisionCountersign` INSERT
unless the SAME transaction carries BOTH the finalized flip on that exact
revision AND the decision's `awaiting_countersign → approved` transition —
row, flip and status are ONE transaction or none; the orphan row and the
split two-transaction replay are probed (P31). **The countersigner must BE
an architect**: the INSERT seal validates `countersignedById` holds ACTIVE
`architect` standing on the project at the act (`platform_user_holds_role`,
under `phase6_try_readiness`); a non-architect and a removed-architect
attribution are probed.

**The finalizing event is a fact the provisional approval RECORDED, not a
guess the finalizer makes**: the delivered `approve` emits
`decision.reapproved` when it acts from `change` and `decision.approved` from
`pending` (`prior === 'change'`, `decisions.service.ts`). Under a chain that
act is provisional and its finalizer runs later, so `DecisionApprovalRevision`
gains an immutable `approvedFrom: 'pending' | 'change'`, an immutable
`approvedByName` (the approval-time display name frozen at the act — the
register's `approvedById` names an account whose name can change between the
provisional approval and its finalization) and an immutable
`approvedByRole` (the role HELD at the act, exactly as `DecisionEvent.actorRole`
freezes it) — CHECK-pinned; written by every approve from 4d-ii; NULL only on
pre-4d legacy rows and on rows the previous release writes during the drain
(all finalized, never finalized again); REQUIRED — the birth seal's arm — on
any revision born `finalized = false`; and REQUIRED on EVERY new revision by a
trailing INSERT-time seal 4d-iii installs (#554's review round 1, finding
3: without it a receipt-backed no-chain approval after the drain could insert
a finalized revision with both NULL and pass the whole bundle; historical
NULL rows are untouched, since the seal judges INSERTs). The countersign, or the stranded
`'completed'` resolution, emits `decision.reapproved` when `approvedFrom =
'change'` and `decision.approved` otherwise. The audit register keeps its
shape: the provisional approve appends its `approved`/`reapproved`
`DecisionEvent` (the act happened and is attributable), and the finalizer
appends a `countersigned` (or `stranded_resolved`) `DecisionEvent` — the
service writes both, the seal REQUIRES both (obligation 7); the 4c cycle
count reads revisions, not events, and is untouched. **The durable
`Notification` tells the truth about finality**: the delivered `approve`
writes the green "X approved …" notification UNCONDITIONALLY in its
transaction, so an approval that now lands `awaiting_countersign` would
announce an approval before any architect acted. Under an ACTIVE chain the
provisional approve writes a PROVISIONAL notification instead — "X approved …
— awaiting the architect's countersign", the awaiting colour, never green —
and the finalizer writes the green approved notification, **built from the
provisional revision's FROZEN approver facts**: the text names the APPROVER
exactly as today's does from the revision's frozen `approvedByName` (or
"Client" for a client decider, with the `onBehalfOf` phrasing when a PMC
recorded the client's consent) and carries the finalization as a DISTINCT
attribution ("— countersigned by <architect>", or "— finalized by <PMC> with
no active architect" for `completed`), never claiming the finalizer approved
the option; a rejection or `returned` resolution writes the change-request
notification the existing path produces; with no chain the approve's
notification is byte-identical to today's. Every one of these feed rows is
written by the service in the transition's own transaction, BEFORE the
command's response (the cleared 4b behaviour the snapshot readers depend
on), stamped with the event it announces (`Notification.eventId`, below),
and REQUIRED by the seal that admits the transition (obligation 7). P31
probes the feed beside the domain event: after the provisional approve the
feed carries the provisional text and no green approval; after the
countersign, the green one naming the original approver and the countersigner
separately; a rename between the two acts is probed and the green
notification carries the name recorded at the act. The countersign is a
second, separately-attributed register act referencing the exact revision; a
SELF-countersign (architect is also the decider) is TWO explicit acts under
two idempotency keys (P32). `pending` stays unreachable after any approval
act, so 4a's eligibility proof survives 4d intact.

**Browser tabs cannot be drained, so they stand behind a CLIENT CONTRACT
boundary.** The delivered `RecordedCompatInterceptor` treats
`x-vitan-decisions-contract: recorded-v1` as the 4b boundary, and a pre-4d
tab sends exactly that; once 4d-iii lets a chain activate, such a tab could
approve a decision, receive the unknown `awaiting_countersign`, report
"Approved & locked", fall through the chip fallback and hold no
countersign-aware action state. 4d-ii introduces the next contract value
`countersign-v1` (its server half — the interceptor, the in-command
refusals, the completeness tripwire — in 4d-ii-a; the gateway's declaration
and every web surface in 4d-ii-b, §D) — the web gateway declares it on
EVERY request that reaches the API, `req()` AND the direct `fetch('/auth/session')` in
`ApiGateway.connect()` that `useApiSync` takes under `DEV_AUTH` (a
client-boundary tripwire enumerates every `fetch(` site in the gateway and
asserts the header on each API-bound one) — and a sibling transport-layer
interceptor beside the untouched 4b one that, for a request declaring less
than `countersign-v1`: STRIPS from every `decisions` array each row carrying
a shape the contract introduced — `status = 'awaiting_countersign'`,
`deciderKind = 'architect'`, or an open change request whose `origin` is not
`standard` (a `recorded-v1` PMC tab receiving a `countersign_rejection`
request ignores the origin, its `mayWithdraw` renders Withdraw for every
PMC, and the queued `withdrawChange` is then refused by the server — an
action offered that cannot be performed; the PMC's next full load restores
the row) — an awaiting or architect-designated decision demands nothing a
pre-4d tab could do that a reload does not restore; REFUSES with a reload
409 the session/shell read for a user whose token role is `architect` (a
role the bundle cannot map is not hidden, it is refused) and EVERY
token-minting response that can hand the role to a stale tab before that
shell read — `/auth/switch` into an architect membership, and an architect
SIGN-IN through `/auth/login`, `/auth/password/complete`, `/auth/otp/verify`,
`/auth/email/verify` and `/auth/google`, each returning the `TokenResult`
whose `role` the delivered store hands straight to `screensFor` in
`applyAuthResult` (the tripwire enumerates every route whose service method
returns `TokenResult`; `/auth/worker/token` is the device flow and mints no
role a bundle maps); and STRIPS architect memberships from `/me/memberships`,
architect rows from the roster `/projects/:projectId/members` and architect
cards from `/me/portfolio` (`OrgsService.portfolio` builds its rows from
`Membership.role` verbatim). The four 4d-touched commands (`approve`,
`forward`, `countersign`, `disagree`) and `decisions.create`/`updateDraft`
naming the architect designation REFUSE a lesser client with a 409 naming
the contract and asking for a reload whenever the project's chain is ACTIVE
— **judged INSIDE the command, under the lock, never at the transport**: a
boundary-time chain read can race the activation it guards, so the declared
contract travels with the request into the command (the request-scoped
context the actor already rides) and each command re-judges it AFTER
acquiring `lockProjectReadiness`, refusing before any write; with no chain
the approve stays byte-identical. The additive `countersignRequired` passes
through as a field a stale bundle ignores. A TRIPWIRE pins completeness: a
test enumerates every enum value and column 4d adds
(`DecisionStatus.awaiting_countersign`, `DeciderKind.architect`,
`TokenRole.architect`, `Membership.role = 'architect'` on the membership,
roster, switch AND portfolio responses, `TokenResult.role = 'architect'` on
every token-minting response, `ChangeRequest.origin`, `countersignRequired`,
the `DecisionForward` DTO) and asserts each is classified strip / refuse /
additive-ignorable with its server-side refusal named, so a 4d shape added
later without a classification fails it. P29c carries every stale-client
arm — including the activation-between-check-and-approve barrier in both
orderings: the stale approve is HELD after its boundary pass, the activation
commits under the lock, the approve resumes, acquires the lock and is
refused (no awaiting row, no provisional revision, no notification), while
the same sequence with a `countersign-v1` client lands `awaiting_countersign`
exactly once. The boundary is dark until 4d-iii like everything else and is
probed BEFORE the role is enabled. **And the client's approval confirmation
tells the truth**: `ApproveModal.tsx` promises "Will be locked" and the store
flashes "Approved & locked — saved to the server"; the modal reads
`countersignRequired` — "Will be sent to the architect for countersign" — and
the success copy follows the status the command RETURNS ("Approved —
awaiting the architect's countersign"), never a client-side guess.

#### EVERY entry into `approved` is DB-sealed behind the chain

Sealing only the `awaiting_countersign → approved` edge leaves the direct
road open — hostile SQL under an ACTIVE chain could mark the head revision
finalized and move `pending`/`change` straight to `approved`. The BEFORE
UPDATE trigger therefore judges ANY transition INTO `approved`, with three
precisions. **(i) The presence read SERIALIZES — by TRY-ACQUIRE, never by
waiting in a trigger**: the seal calls `phase6_try_readiness(projectId)`
exactly as 4c's request and response seals do — on the SERVICE path the
command already holds the readiness key (advisory locks are reentrant, the
try-acquire succeeds); on a DIRECT write with the key free it acquires and
HOLDS to commit, making the presence read exclusive; on a DIRECT write with
the key CONTENDED it REFUSES the write outright (a row-level `FOR UPDATE` on
architect memberships cannot serialize a FIRST activation — the classic
phantom — and a trigger that BLOCKS on the advisory key inverts the
service's lock order into a deadlock). The same protocol binds the
`Membership` writes that can flip holder-relevant standing (above) and every
seal-trigger cross-table standing read. **The membership seal judges
CONTENT, not only timing**: the delivered `phase6_t4b2_membership_guard`
re-judges the holder-orphaning predicate at the DB for `pending`/`change`
decisions (P39's DB arm); 4d-i EXTENDS its open set with `awaiting_countersign`
for the NAMED holder and the ROLE designations it guards today — and
deliberately does NOT add the architect role to it: the last architect
leaving is the chain DEACTIVATING, resolved by the named command, never a
refused removal. **The two rules meet in ONE row, and the exception is
named**: the sole architect A can be BOTH the last architect and the named
holder (or the last active member of the architect ROLE designation) of a
decision A approved into `awaiting_countersign`; the widened guard would
refuse A's removal while the chain promise says it is never refused. The
guard's awaiting arm therefore EXEMPTS exactly this case — named holder AND
role designation alike, for exactly the last active architect and no one
else: the removal proceeds, the chain deactivates, the countersign deliveries
are cancelled by the consumer above, and the decision stays
`awaiting_countersign` with a DEPARTED holder — the named membership, or a
role designation now holding no one — whose only exits are the stranded
resolution's two outcomes, the `returned` one re-homing the empty
designation with its bundled forward (§A.2 the stranded decision). A named holder who is an architect but
NOT the last one stays refused, the 409 naming the pending countersign.
Probed (P39, P29b) with the hostile direct soft-removal and role-change of an
awaiting decision's holder. **(ii) With the chain ACTIVE**, the legal
entries are: FROM `awaiting_countersign` WITH the SAME-transaction
`DecisionCountersign` row finalizing the head revision; or FROM `change` as
the standard `withdrawChange` RESTORATION — the open request is `origin =
'standard'` AND the head revision is ALREADY `finalized = true` from its
original countersign (the ordinary correction path this seal must not
strand); `pending → approved` and any `change → approved` on an unfinalized
head or a `countersign_rejection` request are refused outright. **(iii)
With the chain INACTIVE, the direct road is NARROW**: direct approval stays
legal only FROM `pending` or `change` — the approvals born under no chain,
today's behaviour byte-identical — AND ONLY WITH ITS BUNDLE (obligation 7:
the same-transaction `DecisionApprovalRevision` citing a completed
`decisions.approve` receipt, the `decision.approved`/`reapproved` event, the
`approved`/`reapproved` `DecisionEvent`, and — from 4d-iii — the
`Notification` bound to that event); an `awaiting_countersign` decision was
born under a chain, so its exit DEMANDS paired evidence even after the last
architect leaves: the same-tx `DecisionCountersign` row, or the same-tx
`DecisionStrandedResolution` row with outcome `'completed'` — a bare hostile
`awaiting_countersign → approved` flip under an inactive chain is refused.
Probed (P37): the direct `pending → approved` hostile flip under an active
chain, the finalized-boolean-only flip, the stale awaiting-flip without the
countersign row, the bare awaiting-flip under an INACTIVE chain, the standard
restoration PASSING, the rejection-request restoration REFUSED, the
inactive-chain direct bundle WITHOUT its event refused at commit and WITH its
complete bundle accepted, and the activation-vs-approval barrier.

#### The finality key, stated exactly

The existing Phase-3/4 provenance rows (`MaterialRequirementSpec`,
`LabourRequirementSpec`) FK onto the register's candidate key `(projectId,
decisionId, version, optionKey)` (`DecisionApprovalRevision_provenance_target_key`).
The finality pin WIDENS that key: the register gains `@@unique([projectId,
decisionId, version, optionKey, finalized])`, each provenance row gains an
immutable `revisionFinalized` column CHECK-pinned `true`, and the composite
FK re-targets the widened key — the `PurchaseOrder.comparisonStatus`
precedent verbatim (Phase 3 F4), so provenance naming an unfinalized revision
is UNREPRESENTABLE and a `finalized → false` flip on a referenced row is
refused by the FK itself. The migration is additive and backfills `finalized
= true` on every existing row and `revisionFinalized = true` on every
existing spec row. **The column DEFAULTS (`true`) are KEPT through the
drain**: 4d-i deploys while previous-release instances still serve, and
those instances insert `DecisionApprovalRevision`, `MaterialRequirementSpec`
and `LabourRequirementSpec` rows that name neither column; born-`true` under
the default is CORRECT for the whole pre-drain window because the reservation
keeps every chain inactive. 4d-iii drops the two defaults, so from then on a
provenance row must state its pin — and the writers are taught first: the
delivered `decisions.approvedRef` returns exactly `decisionId`,
`decisionVersion` and `optionKey`, which `RequirementsService` spreads
verbatim into the material spec insert and into
`LabourRequirementParticipant.writeRequirementSpec`; 4d-ii widens the query
to return the head revision's `finalized` as `revisionFinalized` and to
REFUSE an unfinalized head outright, and EVERY spec writer states it
explicitly — create and revise from the widened `approvedRef`, and the two
CANCELLATION copies (`RequirementsService.cancel` copies the head's
`MaterialRequirementSpec` column by column;
`LabourRequirementParticipant.copyRequirementSpecForCancel` copies the
`LabourRequirementSpec` and its slices) carrying `revisionFinalized` forward
VERBATIM — with a WRITER SWEEP enumerating every INSERT site on the two spec
tables and asserting each states the column. P42 probes the old write shape
succeeding under the kept defaults, the post-4d-iii shape failing, and a
current-version provenance write SUCCEEDING for a material AND a labour
requirement after 4d-iii through the shipped writers — create, revise AND
cancel — RED at base where the three-field spread fails on the required
column. Each is an edit the owning module (activities; labour through its
participant) makes to its own code, and the one foreign fact 4d needs is
DECLARED: membership truth is orgs-owned, routed through the named
participant API and the orgs-owned SQL primitives.

#### Disagreement — the `change` state's OWN machinery honoured

BOTH disagreement outcomes land in `change` AND create the open
`ChangeRequest` in the same transaction, requested by the architect with the
disagreement reason; the command accepts the impacts as OPTIONAL inputs
defaulting to 0. **The request carries its ORIGIN, and the ordinary escape
hatch is closed for it**: `ChangeRequest` gains an immutable `origin:
'standard' | 'countersign_rejection'` (additive, default `'standard'`,
backfilled) — the existing `withdrawChange` (the service's `change →
approved` restoration) would on a disagreement request complete an approval
WITHOUT its countersign, so `withdrawChange` refuses `countersign_rejection`
requests with a 409 naming re-approval as the only way forward (P33). **The
affordance follows the refusal**: 4d-ii serializes the immutable `origin` in
the shared DTO on the live, projected and rebuilt paths alike — PRESENT ONLY
WHEN NON-`standard` (absence hydrates as `'standard'`, so an ordinary
request's wire shape is byte-identical) — and `DecisionLogScreen.tsx`'s
`mayWithdraw` suppresses Withdraw for `countersign_rejection`; P33's web arm
asserts no Withdraw renders for a rejection request while the direct call
still 409s. **The request's EVIDENCE freezes with its origin and its
decision**: the delivered `phase6_t4b2_change_request_seal` freeze is EXTENDED
to cover `origin`, `decisionId`, `revisionId`, `projectId`, `sourceCommandId`,
`requestedByRole`, `requestedByName`, `reason`, `costImpact`,
`timeImpactDays` and `requestedById` for EVERY `ChangeRequest` row, with the
close transitions as the only permitted mutations — a hostile re-label of an
open `countersign_rejection` request to `'standard'` would reopen the closed
escape, and a re-point to another decision would strip the change-state
decision of its one open request; both are probed (P33). The two paths:
**REJECT BACK** keeps the original decider as holder — they re-approve and
the chain runs again; **FORWARD ON** re-points the holder to the decider the
architect names (validated active) — through the SAME forward door with the
SAME `DecisionForward` fact as the generic command, taken from
`awaiting_countersign` in the same transaction that lands `change` (which is
why the door's status predicate admits `awaiting_countersign → change` ONLY
when the transaction also carries the `countersign_rejection` request) — the
new holder finds an actionable change-state decision, re-approves, and the
chain runs again. Neither path returns to `pending`; neither erases the
approval act it answers; approve-from-`change` under an ACTIVE chain lands
`awaiting_countersign` exactly like approve-from-`pending`. Probed end to
end (P33). The `countersign_rejection` `ChangeRequest` carries the frozen
`requestedByRole`/`requestedByName` pair (CHECK-required exactly when
`origin = 'countersign_rejection'`) and its provenance (§A.3 obligation 6,
§B.6).

#### The push families, and the send boundary stated where it can hold

Two families join the delivered three: `decision.forwarded` (`pushFamily:
'forward'`, at the NEW holder) and `decision.awaiting_countersign`
(`invalidate: true`, `pushFamily: 'countersign'`, at the ARCHITECTS; also the
re-emit's entry). **Both are USER-TARGETED AT EMISSION, with their
recipients frozen in the record** (the answer to #552's second finding):
the emitting command — `forward`, `approve` under a chain, and the
`decisions.effects` re-emit — resolves the recipients under the readiness
lock it already holds (a named-member `toDesignation` → its user; a role
designation → the role's current holders through the orgs participant's
`effectiveRoleHolderUserIds`; the countersign demand → every active
architect), and passes them as `dispatch.push.targetUserIds` — a plural
sibling of the delivered `targetUserId`, admitted by `buildDispatchIntent`
only for a catalog entry whose `pushFamily` declares a frozen audience, and
copied into the delivery payload by the platform's `deliveryRowsFor`
projection exactly as `targetUserId` is. The dispatch intent is immutable
on the `DomainEvent` row, and the delivery's `payload`/`subject` are BOUND
to it at insert and FROZEN afterwards (§A.3 obligation 7, the delivery
seal — #560's review round 1, finding 4), so WHO was demanded is durable
from the instant of emission and cannot be narrowed in the queue; and the
standing cannot move between the
resolution and the commit because EVERY `Membership` writer takes the ONE
readiness key — not only the architect path (#556's review round 1,
finding 2: a forward to the `client` role holding the key resolves holder
A; a direct insert of an active client B took no key, the delivered
`phase6_t4b2_membership_guard` admitting an addition that reduces no
standing, and could commit after the correspondence seal's read and before
the forward's commit, so the immutable intent froze A alone while B held
the role at commit). 4d-iii installs the orgs-owned `Membership_t4d_readiness`
BEFORE INSERT OR UPDATE OR DELETE row trigger, which calls
`phase6_try_readiness(NEW."projectId")` (and `OLD."projectId"` on UPDATE
and DELETE) on EVERY `Membership` row write of EVERY role — the delivered
try-acquire-or-refuse protocol: reentrant for a command that already holds
the key, acquire-and-hold-to-commit when the key is free, REFUSED outright
when another transaction holds it (a seal never waits inside a trigger, so
no lock-order inversion exists). A standing write therefore either
committed before the emitting command took the key — and the audience read
under the key sees it — or is refused while the command holds it, and the
frozen `targetUserIds` equals the set at commit by construction, for every
writer. **The trigger is staged in 4d-iii, after the attested drain, and
not a unit earlier** (#556's review round 2, finding 2: staged in 4d-i it
would have met the previous release's `signInOrProvision`, which writes the
`User` and the `Membership` as two statements, so a membership refused
while a command held the key would leave a user the retry FINDS and then
fails to sign in — `signInAccess` finds no membership — permanently and
without repair; that is not a retryable residual, and no residual is
admitted here). No frozen-audience family can emit BEFORE 4d-iii: the
forward door refuses 409 while the reservation stands and a countersign
demand needs an architect the reservation forbids, so the serialization is
needed exactly from 4d-iii — and by then every `Membership` writer is the
new release's and holds the key. 4d-ii gives the four writers outside
`members.service` (which already holds the key) — the sign-in provisioning,
project creation, `prisma/seed.ts` and `ensure-accounts` —
`lockProjectReadiness` (the waiting form), and makes the sign-in
provisioning ONE transaction (user + membership) under it, so no writer of
the new release can be refused and none can leave a half-provisioned
account; the previous release never meets the trigger. **And the
`OrgMembership` writers join the same protocol, because they DO supply an
audience** (#556's review round 2, finding 4: the delivered
`effectiveRoleHolderUserIds` resolves the `pmc` role as the active `pmc`
memberships UNION the org's owners/admins who hold NO active membership on
the project, so an `OrgMembership` insert or promotion adds a `pmc` holder
to every project of the org; round 1's exemption was false for that role).
`platform_role_holder_user_ids(project, role)` carries the SAME org-owner arm
for `pmc` (the participant wraps it, one SQL), and 4d-iii installs the
orgs-owned `OrgMembership_t4d_readiness` BEFORE INSERT OR UPDATE OR DELETE
row trigger, which — on any write whose OLD or NEW role is `owner` or
`admin` — tries the readiness key of EVERY project of the org in ascending
project id (the set and the order the delivered `guardedOrgStandingWrite`
already locks for a reducing write) and refuses when any is contended; the
org writers (`orgs.service.ts` create/add/re-role/remove, the seed's and
`ensure-accounts`' org upserts) take `lockProjectReadiness` over the same
set in the same order in 4d-ii, additions and promotions included. **And
the SET itself is serialized by ONE org-level key, because a per-project
key cannot close a phantom** (#557's review round 1, finding 3: an org
writer that enumerated the org's projects before an uncommitted new
`Project` was visible took no key for it, and a forward on that project,
once created, could freeze a PMC set the concurrently committing owner was
omitted from — taking the new project's key in project creation does not
help, since the org writer never discovered that key). 4d-ii adds
`lockOrgStanding(tx, orgId)` — the same `pg_advisory_xact_lock` shape on
`'org:' || orgId` — and its trigger form `phase6_try_org_readiness(orgId)`
(4d-iii): PROJECT CREATION takes the org key before it inserts the
`Project` and its creator membership, and EVERY owner/admin `OrgMembership`
writer takes the org key FIRST and only then the project keys ascending
(`OrgMembership_t4d_readiness` tries the org key and then each project
key, refusing when any is contended), so a project cannot appear while an
org write is in flight and an org write's enumeration under the org key
sees every committed project. **The door is on the TABLE, not only in the
service** (#557's review round 2, finding 1): the orgs-owned
`Project_t4d_org_readiness` BEFORE INSERT trigger (4d-iii, beside the two
standing-writer seals) tries `phase6_try_org_readiness(NEW."orgId")` on
EVERY `Project` insert — reentrant for the creation that holds the key,
acquire-and-hold when free, refused when an org write holds it — so a
direct insert cannot slip a project past an org write's enumeration any
more than the service can. **And the creator's authority is judged UNDER
the key** (#557's review round 2, finding 3: the delivered `createProject`
reads the caller's org role before its transaction, so an admin could pass
the read, be demoted by an org write that took the key first, then acquire
the key and create): 4d-ii keeps the pre-transaction read as the fast
refusal and RE-JUDGES owner/admin standing after `lockOrgStanding` is held,
inside the transaction and before the `Project` insert, refusing 403 when
the standing is gone. The lock order org → project is the ONLY
order — project creation takes org then (through the membership trigger)
its own new project key, an org writer takes org then projects ascending,
a command takes one project key and never the org key — so no cycle
exists. P36's arm: project creation vs an owner insert for the same org
under the barrier in BOTH orderings, then a forward to the `pmc` role on
the new project — creation-first → the owner write took the new project's
key too and the frozen set is the full effective set; owner-first → the
project appears after the owner committed and the frozen set includes the
owner; in neither ordering is a committed effective holder absent from
`targetUserIds` at the forward's commit; RED in the seal-stripped run
where the phantom lands; the same barrier with a DIRECT `Project` insert in
place of the service's creation (owner-first → the insert refused as
contended by `Project_t4d_org_readiness`, accepted after the commit;
insert-first → the owner write's enumeration sees it), RED where the table
door is omitted; and the demotion-vs-creation barrier in both orderings —
demotion-first → creation refused 403 at the in-key re-judge, creation-first
→ the demotion takes the key after and the project stands with its creator
as PMC. A
command holds one project's key and never waits for an org's set, and every
org writer takes the set ascending, so no deadlock exists; a `member`-only
org write touches no audience and takes no key. P36's arm:
forward-to-`client`-role vs a direct insert of active client B under the
barrier in BOTH orderings — B first → the frozen set holds A and B; forward
first → B's insert is REFUSED as contended by name, succeeds after the
commit, and the frozen set equals the audience at the forward's commit
either way; the same shape for an `engineer` provisioning sign-in racing a
forward to `engineer`, and for a forward to the `pmc` role racing an
`OrgMembership` owner insert (B-first → {A, B}; forward-first → the org
write REFUSED, the frozen set {A} equal to the audience at commit); RED in
the seal-stripped run where B commits mid-forward and the intent omits a
holder at commit. The consumer sends to that frozen set and
to no one else — it never resolves a role at claim for these two families;
a recipient is skipped at the send when the per-recipient re-judge below
finds their standing ended; an architect activated AFTER the demand was
raised (A active, B added — no crossing) receives no push for it, which is
the honest reading of a push as a nudge: B's Inbox item and Decision Log
controls carry the demand regardless (the reader table above), and the
crossing consumer raises a fresh demand exactly when the chain reactivates
from zero. The delivered families keep their delivered resolution
(`decider` resolves a role's current holders at claim through
`roleHolderUserIds`, the 4b mechanism; the two consultation families are
user-targeted already). **The bodies of the two new families are GENERIC by
construction** — the countersign push says a decision awaits the recipient's
countersign and the forward push that a decision has been forwarded to them,
neither naming the decision, option or material; the app opens the decision
under its own authorization — so their residual (below) discloses only that
a decision exists; the DELIVERED families' bodies (the decider title, the
consultation title, the approval announcement) are 4c's cleared surface, left
as they are and named for what they carry.

**The decider push follows the forward AT CLAIM** (the 4c hand-off,
weighed): the delivered `deciderPushTarget` reads its decision with a plain
`findFirst`, which was correct while the holder could not move after
publication. It can now. The claim predicate therefore takes the decision
row's lock before reading the holder (the discipline 4c's consultation claim
already uses), so a forward committing between enqueue and claim re-targets
the pending DECIDER push at the installed holder or drops it with the
recorded cancellation mark, while a still-standing consultee push SURVIVES
the same forward. Each new family's claim predicate is a `decisions.*PushTarget`
query bound at bootstrap under the BUMPED `webpush.notify` contract:
`forward` — actionable while the decision is `pending`/`change` AND the
installed holder is still the delivery's frozen target; `countersign` —
actionable while the decision is `awaiting_countersign` AND an active
architect exists; each re-checks project operability FIRST through
`phase6_project_operable` (the 4c order) and drops a non-operable project's
delivery with the recorded mark exactly as the delivered consultation
predicates do (P38, one positive and one negative per family; a valid
consultee push is NOT dropped by the countersign predicate).

**The guarantee is stated at the boundary it can actually hold.** The
delivered `makePushConsumer` awaits the claim query's OWN transaction and
only then calls the EXTERNAL `notifyTargetedUser`, so the decision row lock is
released before the send; the send is external I/O and cannot be inside any
transaction. 4d therefore closes the window to the provider call itself and
DISCLOSES what remains:

(i) **EVERY command that changes the fact a family's claim predicate reads
CANCELS that family's not-yet-sent deliveries by subject**, under the same
lock the predicate reads under — the 4a `cancelQueuedPushBySubject`. Stated
for every family this unit touches: a forward cancels that decision's
`decider` AND `forward` deliveries (a second forward invalidates the first
forward's push at the now-displaced holder exactly as it invalidates the
decider's); `approve` — landing `approved` directly or `awaiting_countersign`
under a chain — cancels that decision's `decider` AND `forward` deliveries
(a delivery claimed before the approval passes the consumer's delivery-row,
standing and project re-reads and would send "awaiting your approval" after
the holder acted; the family predicates' STATUS arm refuses at CLAIM and
again at the SEND, and the in-flight one still gets the mark); every
transition that LEAVES the consultation-open set — the no-chain approve, the
countersign, the `completed` stranded resolution, the standard
`withdrawChange` — cancels that decision's `consultation_requested`
deliveries by subject (an invitation `consultation.respond` then refuses; the
approval INTO `awaiting_countersign` cancels nothing of this family, since
consultations stay open while awaiting; `consultation_responded` deliveries
are information, not invitations, and keep the withdrawn-audience rule);
countersign, disagree and the stranded resolution cancel that decision's
`countersign` deliveries (the demand is gone, whichever way); the PMC's
`withdraw` cancels that decision's `decider` AND `forward` deliveries, EVERY
`consultation_requested` delivery regardless of target (a request is an
invitation to act that `consultation.respond` refuses on a withdrawn subject
for a PMC consultee exactly as for anyone else), and the
`consultation_responded` deliveries ONLY where the target lacks PMC standing
(`hasProjectRoleStanding(user, ['pmc'])` false — the architect requester; a
withdrawn decision is pmc-only, but a PMC may still be told advice was given
— through a NARROWING `targetUserIds` arm on `cancelQueuedPushBySubject`,
judged against the event's own durable dispatch intent); and the
last-architect deactivation's cancellation of every awaiting decision's
`countersign` deliveries is derived by `decisions.effects` from the event
(above), never left to the membership mutation. **Every cancellation takes
its locks in ONE order** — the delivered readiness → `Project` →
`Membership` order, then the subject `OutboxDelivery` rows `FOR UPDATE` in
ascending id, THEN the `Decision` row — because the relay's claim leases the
delivery first and then the family predicate takes the decision lock; a
command holding the decision and then reaching for a leased delivery would
deadlock and abort one side toward dead-letter. A delivery the command finds
already leased by a claim is SKIPPED, never waited for: that claim, blocked
on the decision lock the command holds next, resumes after the commit and its
final pre-send re-read observes the transition and drops the send with the
mark. The `withdraw` command's target-aware response cancellation reads the
decision's consultation entries WITHOUT the decision lock, locks every
response target's membership in ascending membership id and judges its
standing, THEN takes the delivery rows and the decision row and re-validates
the consultation set under it — an entry that appeared between the two reads
means a membership this transaction has not locked in order, so the command
refuses as contended (the try-acquire posture; the client retries) rather
than lock out of order. P35's barrier gains each command against a
concurrent claim in both orderings, no deadlock; P40/P41 gain the
withdraw-vs-respond barrier in both orderings.

(ii) **The consumer performs a FINAL re-judge immediately before EACH
recipient's provider call**, ONE HOOK for EVERY recipient of EVERY family: the
delivery row's cancellation mark (family-agnostic by construction); the
PROJECT — the delivered `OrgsParticipant.isProjectOperable`, the row-locking
read, so the archive waits for the check or the check sees the archive; the
PERSON, by the family's OWN standing rule and never a uniform membership
test (a `consultation_responded` requester may be an org owner/admin with NO
`Membership` row on the project, exactly why 4c keyed that target by user):
the responded family re-applies `hasProjectRoleStanding(user, ['pmc',
'architect'])`; the named-decider, consultee and forward-holder families
re-check the named membership's ACTIVE standing
(`phase6_membership_active_user`); a role fan-out and the countersign's
frozen set re-check `platform_user_holds_role(project, user, role)` — all
through the orgs participant; and the SUBJECT — the family's OWN claim
predicate re-run (target-aware wherever the claim is), as a decisions-owned
read of the decisions-owned `Decision` row, so a decision that left the
actionable set between claim and send never sends. The outcome follows one
rule: a subject or project that left the actionable set BEFORE any send
drops the WHOLE delivery with the recorded mark (`OutboxDelivery` carries one
delivery-wide `cancelledAt`/`deliveryAction`, so the mark is the right
instrument only when the whole delivery drops); a stale RECIPIENT is SKIPPED
without touching the mark and the delivery completes `succeeded`/`dispatch`
with the recipients actually sent, the mark set only when EVERY resolved
recipient fails (a user-targeted delivery has one recipient, so its failure
IS the whole delivery); a subject or project that leaves BETWEEN sends skips
every remaining recipient without touching the mark. **An ARCHIVED project
is the delivered 4c rule, not a new mechanism** (§A.4): the delivery is
dropped with the recorded cancellation mark at claim or at the pre-send
barrier, and restoration re-notifies nothing — exactly what every delivered
decision push family already does, and what the Board's "a consultation
informs, never gates" ruling accepts for a push, which is a nudge: on
restoration the awaiting decision is in the architect's Inbox and Decision
Log, the forwarded decision in the holder's, and nothing is stranded. Durable
per-recipient evidence was weighed and not taken: it needs a new column on
the platform's delivery row for a fact the push provider's own log already
carries.

(iii) **The residual** — an invalidating command committing after that final
re-read and before the provider accepts the send — is a stale push to the
displaced holder, **a POST-REVOCATION DISCLOSURE of whatever the body carries,
stated as such**: for the two new families, only that a decision exists;
for the delivered families, the title (or the option and material for the
announcement) reaching a device whose standing ended inside the
provider-call window — the same class as the 4c stale-tab residual the Board
ruled on, recorded as a disclosure bound, not claimed away.

P40 therefore proves, PER FAMILY: the claim-time re-target; the
invalidation-vs-claim barrier in both orderings — invalidation-first → the
delivery re-targets or cancels at claim; claim-first-then-invalidation-
before-send → the final re-read drops it, asserted by holding the consumer at
the pre-send barrier — for the decider (a forward), the forward family (a
SECOND forward after the first's claim, AND a PMC withdrawal after the claim),
the countersign family with its FROZEN set (A and B frozen, A removed at the
pre-send barrier → B receives, A receives nothing, the delivery
`succeeded`/`dispatch` unmarked; the last architect removed after the claim →
nothing sent, the delivery marked; A frozen alone, B added with no crossing
→ B receives nothing from this delivery and holds the Inbox item), the
USER-targeted families (a `consultation_responded` push claimed for an
active architect requester who is removed at the pre-send barrier → nothing
sent; the PMC requester's response SURVIVES a withdrawal committed at its
pre-send barrier while the architect requester's is dropped; an org-admin
requester with NO membership row RECEIVES the response push), the
direct-transition arm (a `decider` push claimed, a direct `pending →
approved` bundle committed at the pre-send barrier under an inactive chain →
nothing sent, the delivery marked; the fan-out arm — A sent, the transition
committed at B's pre-send barrier, B skipped, no mark), the archive arm
(archive at the pre-send barrier → nothing sent, the delivery marked;
restoration re-notifies nothing and the awaiting decision is served to the
architect's Inbox on the next read), and the consultee push surviving each.
This is a change to 4c's cleared surface, made here deliberately and named
as such.

### 3. The uniform seal contract — every 4b–4d fact table

The starting material stated the rule as six DB obligations beside each
fact's zod contract and service authority. This plan adds a SEVENTH, the
generative rule behind #552's first finding and the fourteen review rounds
before it. Each fact table carries:

1. **Append-only + evidence freeze** — UPDATE/DELETE sealed at the row AND
   `TRUNCATE` sealed at the statement (both named; a row trigger never fires
   for TRUNCATE); every evidence AND discriminator column immutable
   (`origin`, kinds, designations, `outcome`, the frozen `<act>ByRole` /
   `<act>ByName` pair included), with the named close-transitions as the
   only permitted mutations.
2. **Transition pairing, BOTH directions** — where the fact records a state
   transition, the row commits only with its same-transaction transition and
   the transition only with its row (deferred constraint triggers — the
   forward-door discipline); EXACTLY ONE fact per paired transition (§B.5).
3. **Actor standing** — the recorded actor must hold ACTIVE standing that
   authorizes the act, judged at the DB under `phase6_try_readiness`; AND the
   fact's frozen `<act>ByRole` must be a role THAT actor holds — judged per
   user by the kernel read `platform_user_holds_role(project, user, role)`
   over the platform-owned `ProjectUserStanding` register (§A.2), whose
   `pmc` row the orgs trigger derives for the membership-less org
   owner/admin too (the token role `AuthService.signInAccess` and the
   project access path issue such an actor; the register row is the
   evidence, and no separate label is recorded or demanded) — **EXCEPT
   through the window, where a `pmc` claim is judged by the RACE-FREE
   derivation and not by that register** (#572's review round 25, finding 8).
   The window rule is stated generally three sections above — *through the
   window, NOTHING a window caller reaches may judge a user's `pmc` standing
   from the fanned-out row* — and the approval revision's and the change
   request's pair checks were both re-pointed onto the `ProjectOrg` /
   `OrgUserAuthority` derivation for it. THIS clause, which every fact's pair
   check reads, was left naming the register alone, so the CONSULTATION
   request's frozen `requestedByRole = 'pmc'` would be refused for exactly the
   org owner/admin the delivered requester-authority arm admits — and P29b
   promises that window request COMMITS. So the arm reads: an
   `OrgUserAuthority` owner/admin row for that actor's org AND no
   membership-granted row for them on that project, until 4d-iii re-points it
   onto the repaired register after the re-projection. A general rule left
   unapplied at one of its own sites is not a rule; it is the fourth time this
   plan has recorded that, and it is why the clause now carries the exception
   inline rather than relying on a reader to remember the section above — AND its
   frozen `<act>ByName` must equal the account's display name read by the
   kernel's `platform_user_display_name(userId)` over the `UserIdentity`
   register at the act — **and the command must READ that name inside its own
   transaction, from the register, with the identity row locked** (#572's
   review round 11, finding 3). An earlier spelling of this clause argued that
   "the fact is written in the act's transaction, so 'at the act' and 'at
   commit' are the same instant". They are not: `resolveActor` reads
   `User.name` BEFORE `executeCommand` opens its transaction, so a rename
   committing in between projects a new `UserIdentity` value, and the fact's
   INSERT trigger then compares a stale frozen name against the fresh register
   and rolls back a command that was authorized and correct. The rename is not
   hostile and the actor is not at fault — the failure is entirely an artifact
   of reading the name outside the transaction that freezes it. So every 4d
   fact writer resolves the frozen NAME from `UserIdentity` INSIDE
   `executeCommand.run`, taking the identity row `FOR UPDATE` before it reads:
   a concurrent rename then either commits first (and the fact freezes the NEW
   name, which is the truth at the act) or waits behind this transaction (and
   the fact freezes the old one, equally true at its act). The seal is unchanged
   — it still compares the frozen pair with the register — because the
   comparison is now between two values read under the same lock. **The
   identity row is locked AFTER `Membership` in the canonical order** (readiness
   → `Project` → `Membership` → the per-user registers → the subject's delivery
   rows → `Decision`), which is the order the orgs standing trigger already
   takes: it writes `UserIdentity` and `ProjectUserStanding` from a `Membership`
   write it is nested in, so it holds the membership row first. A fact writer
   that took the register before `Membership` would invert that against every
   concurrent membership write.

   **The pair is split by HALF, and only the NAME comes from the registers
   through the window** (#572's review round 12, finding 3). Round 11's fix said
   "the frozen pair", and generalizing a NAME correction onto the ROLE put a
   window-reachable WRITER onto the fanned-out `ProjectUserStanding` — the one
   thing §A.2's window rule forbids. Through 4d-i → 4d-iii a membership-less org
   owner/admin has no fanned-out `pmc` row, so a writer resolving its own role
   from that register would resolve NOTHING for exactly the actor the delivered
   access path authorizes, and the command the service admitted could not name
   the role it acts in. The ROLE therefore keeps §A.2's WINDOW DISPOSITION,
   per row, exactly as the seals that judge it do: the actor's token role for a
   membership-granted role, and the race-free derivation — an `OrgUserAuthority`
   owner/admin row AND no membership-granted row for that actor on that project
   — for a `pmc` claim by a membership-less owner/admin, until 4d-iii re-points
   writer and seal onto the register together, in the same transaction. Both
   halves are still read inside `executeCommand.run` under the lock discipline
   above, because the staleness round 11 found is real for the role too: a
   re-role committing between `resolveActor` and the fact's INSERT would leave
   the seal comparing a stale frozen role against a fresh read. What round 12
   corrects is the SOURCE of the role, never the timing. P29b gains the barrier: a rename held open by a second session
   while a fact-writing command runs, asserted to COMMIT in both resume orders
   with the frozen name matching whichever rename won, RED against the
   pre-transaction read, which rolls back; a supplied role the
   actor does not hold, or a supplied name that is not the account's, is
   refused at the FACT (the service command stays the authority; the seal
   is the hostile-path backstop; no decisions- or platform-owned trigger
   reads an orgs table — standing and identity reach every seal only
   through the registers the orgs triggers write, #561's review round 1,
   finding 1).
4. **Subject eligibility** — the decision must be in exactly the states the
   act is legal in: the SAME predicate as the command CAS, re-judged by the
   seal — AND the project operable via `phase6_project_operable`, lock before
   read, the 4c §A order.
5. **Same-project composite FKs** — every reference project-bound through
   the child's own `projectId`.
6. **Command provenance** (4c, delivered) — `NOT NULL sourceCommandId` with
   the project-contained composite FK to `CommandExecution`, the one-use
   `(projectId, sourceCommandId)` UNIQUE, and the deferred result-binding
   constraint trigger tying the row to the reserved command's RESULT and
   the receipt's `actorId` to the row's recorded actor.

   **Discharged PER WRITER, not per finding** (#572's round-3 root-cause
   audit). Every command this plan puts on the ledger whose fact carries
   required provenance ALSO opts into `synthesizeKeyWhenAbsent: true` and
   carries a probe that drives it with NO `Idempotency-Key` header. The reason
   applies to all of them identically: `COMMAND_KEY_ENFORCED` is unset by
   default, so an unkeyed call takes `executeCommand`'s LEDGER-LESS branch and
   `run` receives a null `commandId`, which a required `sourceCommandId` then
   rejects — on a call the current API accepts. Synthesis reserves a per-call
   server key and changes nothing else (two unkeyed retries still each run
   once, a client key still replays exactly once, enforcement still refuses a
   missing key BEFORE synthesis is considered); requiring the header instead
   would be a new client error on a valid call, and is rejected on that
   ground. The covered set is DERIVED, not listed
   (#572's review round 4, finding 3). It is exactly: every command in §D's
   inventory whose fact appears in the §A.3 fact table with a provenance
   column reading `required`. There is no hand-maintained roster to keep in
   step, because a roster is what failed here three rounds running — round 1
   fixed `requestChange`, round 3 added the three membership commands and
   called that list "exhaustive", and round 4 found four more (`decisions.forward`,
   `decisions.countersign`, `decisions.disagree`,
   `decisions.resolveStrandedCountersign`) that the same paragraph goes on to
   discuss by name two sentences later. A rule that requires me to remember
   its instances has the defect built in; a rule read off a table the plan
   already maintains does not.

   Derived TODAY, as a check on the derivation rather than as the authority:
   `DecisionForward`, `DecisionCountersign` and `DecisionStrandedResolution`
   are `required`, so `decisions.forward`, `decisions.countersign`,
   `decisions.disagree` (its forward-on and reject-back bundles) and
   `decisions.resolveStrandedCountersign` are covered; `ChangeRequest` is
   `required` for the `countersign_rejection` origin, so `requestChange` and
   `disagree` are covered; `ChangeRequest` also carries a second, CLOSURE
   provenance column (`resolvedByCommandId`, #572's review round 5, finding
   5) whose writers are every command that writes `resolvedById` — so
   `decisions.withdrawChange` AND `decisions.approve` (its re-approval closure
   branch) are covered (#572's review round 6, finding 1); `MembershipTransition`
   is `required`, so `members.add`, `members.updateRole` and `members.remove`
   are covered — and for `members.add` the receipt must cover the IDENTITY
   PROVISIONING too (#572's review round 8, finding 1): the delivered command
   looks the user up and CREATES a missing one before its membership
   transaction (`members.service.ts`), so two requests carrying the same
   `Idempotency-Key` for a new email can both observe no user, one creates it,
   and the other fails on the user uniqueness constraint before it ever
   reserves or replays the receipt — the keyed replay this plan promises
   covering only the half of the operation that happens after the identity
   exists, and any later failure inside the command leaving a provisioned
   identity outside the receipt's transaction. 4d-ii-a moves the lookup AND
   the create inside `executeCommand.run`, so the whole add is one atomic,
   replayable unit. TEN commands. **The derivation is per COLUMN, and each
   column's writers are derived in turn from the column that column
   qualifies** — two corrections, one round apart, and the second is the first
   applied to itself. Round 5 forced the per-COLUMN half: reading it per table
   would have missed the withdrawal, because the request's own column was
   already `required` and made the row look covered while the command that
   CLOSES it was on no ledger at all. Round 6 forced the other half: round 5
   then NAMED that new column's writer instead of deriving it, and missed
   `approve`'s re-approval closure — a hand-written set introduced by the very
   round whose audit concluded that a rule needs a reader. If a reader derives a different set from the §A.3
   table, the table is the answer and this paragraph is the error. **Extended for
   BUNDLES**: the delivered `phase6_t4c_provenance_bound` requires the
   receipt's `resultRef` to name the row itself, which a command writing ONE
   fact satisfies and a command writing a bundle (forward-on: request +
   forward; the stranded return: resolution + request, + the departed
   holder's forward) cannot. The 4d-owned `phase6_t4d_provenance_bound`
   accepts a `resultRef` naming the row OR the bundle's PRIMARY fact when the
   same transaction pairs them and both cite the SAME receipt — the primary
   is the reject-back/forward-on REQUEST for `decisions.disagree` and the
   RESOLUTION row for `resolveStrandedCountersign`; the per-table one-use
   UNIQUE still holds. **And the receipt is IDENTIFIED before it is matched**
   (#582's review round 1, finding 12 — a hole in THIS rule, not an
   abbreviation of it, which is why the rule itself gains the clause):
   `status` and `resultRef` do not say which command a receipt belongs to,
   and `resultRef` = the row's own id is an equality over a WRITER-CHOSEN
   column — give a forged `DecisionForward` the id of an existing decision
   and cite that decision's `decisions.create` receipt, and the identity arm
   accepts it as forward provenance; nor does either column say who acted, so
   a fact could name one actor while its receipt recorded another and the
   frozen attribution pair would be truthful about a person who did nothing.
   So `phase6_t4d_provenance_bound` reads the receipt's `commandType` and
   `actorId` too, and requires the command to be one that WRITES this fact
   table — `DecisionForward`: `decisions.forward` or the two bundle commands
   (`decisions.disagree`, `decisions.resolveStrandedCountersign`);
   `DecisionCountersign`: `decisions.countersign`;
   `DecisionStrandedResolution`: `decisions.resolveStrandedCountersign` — run
   by the SAME actor the fact attributes it to (`forwardedById`,
   `countersignedById`, `resolvedById` respectively). The map fails CLOSED: a
   fact table bound by this trigger with no declared command kind is refused
   outright, so a later unit cannot add a table and leave its provenance
   unchecked. `phase6_t4d_membership_transition_bound` carries the same two
   clauses over `members.add`/`members.updateRole`/`members.remove` and
   `MembershipTransition.actorId`. `ChangeRequest` joins the contract — and it carries no
   `projectId` today, so 4d-i adds `projectId`, backfilled from each row's
   decision and, for every later INSERT, filled by a BEFORE INSERT trigger
   that copies it from the row's decision when the writer omits it (so the
   column is `NOT NULL` from the start while the previous release's
   `requestChange`, which never names it, keeps working during the drain),
   bound by a composite FK `(projectId, decisionId)` to the delivered
   `Decision(projectId, id)` candidate key; THEN the nullable
   `sourceCommandId` with its composite FK and partial one-use UNIQUE, which
   the P33b seal REQUIRES for every `countersign_rejection` row. A
   `'standard'` request written by 4d-ii's `requestChange` carries
   `sourceCommandId` too, and its receipt must BIND: 4d-ii changes the
   `decisions.requestChange` receipt to name the created `ChangeRequest.id`
   (a command that writes a fact names THAT fact; `resultRef` is receipt
   evidence, never the command's response). For that receipt to EXIST at all,
   4d-ii's `requestChange` also opts into server key synthesis
   (`synthesizeKeyWhenAbsent: true`). `COMMAND_KEY_ENFORCED` is unset by
   default, and `executeCommand` then takes its LEDGER-LESS branch for a caller
   that sends no `Idempotency-Key`, handing `run` a null `commandId` — so an
   unkeyed request writes a NULL `sourceCommandId` and, once 4d-iii requires
   the column, rolls back a call the current API accepts (#572's review round
   1, finding 2). Synthesis is this codebase's delivered answer to exactly that
   problem — the inventory ledger took it when `StockTransaction.sourceCommandId`
   became NOT NULL — and it changes nothing else: it reserves a per-call server
   key, so two unkeyed retries still each run once exactly as the ledger-less
   path did, a client that DOES send a key keeps its exactly-once replay, and
   enforcement still refuses a missing key BEFORE synthesis is considered.
   Requiring the header instead would be a NEW client error on a call that is
   valid today, and is rejected on that ground. A NULL stays admissible on
   standard rows ONLY during the drain, for the legacy rows and the previous
   release's writer: 4d-iii installs the trailing INSERT-time seal requiring a
   non-NULL `sourceCommandId` on EVERY new `ChangeRequest` row whatever its
   origin — historical NULL rows untouched.
7. **Effect correspondence — a seal VERIFIES, it never EMITS.** Where the
   fact's transition owes an effect, the transition commits only with that
   effect present in the SAME transaction, judged at the deferred pairing
   check: exactly ONE `DomainEvent` of the transition's event type, in the
   project, about the decision (`entityType = 'Decision'`, `entityId` the
   decision), `actorKind = 'human'` with `actorId` equal to the paired
   fact's recorded actor AND the envelope's `actorRole`/`actorName` equal to
   the fact's frozen pair (#555's review round 1, finding 2: the delivered
   envelope carries no role or name, so 4d-i adds both as nullable columns
   the delivered `20261015000000` append-only trigger freezes, `emitEvent`
   writes them from the actor it is HANDED from 4d-ii — the columns land
   DARK in 4d-i and nothing writes them until the service unit — and a NULL
   pair is admitted through the drain on EVERY sealed event type a
   previous-release writer can emit — the no-chain approve's
   `decision.approved`/`reapproved`, the standard `requestChange`'s
   `decision.change_requested`, `withdrawChange`'s
   `decision.change_withdrawn`, and the two consultation events — since the
   pre-4d-ii `emitEvent` writes neither column for ANY of them, the
   attribution arm binding `actorId` alone whenever the pair is NULL
   (#567's review round 1, finding 2: admitting NULL on the approve alone
   would have refused the four other live legacy commands at commit until
   4d-ii deployed; the legacy-writer table below states every branch); the
   trailing 4d-iii seal then requires the pair on every new event of EITHER
   kind — a `systemActor` carries a constant name and
   role by construction). **Every emitter hands the pair, and the compiler
   is the tripwire** (#555's review round 2, finding 1: round 1 claimed
   `resolveActor` supplies the pair to every emitter, which the commercial
   write-through seam falsifies — `CommercialParticipant.AttributionActor`
   is deliberately `actorId`/`actorKind`/`role`, constructed as that reduced
   object at sixteen sites in `purchase-orders.service.ts`,
   `labour-procurement.service.ts`, `commercial-measurement.service.ts`,
   `commercial.service.ts`, `inventory.service.ts`,
   `commercial-activation.service.ts` and `commercial-reevaluate.cli.ts`,
   and `CommercialBudgetService.evaluate` passes it to `announceMoneyMoved`
   as an `EventActor`, so after 4d-iii a PO issue or amendment on a
   commercial-enabled project would emit `commercial.money_moved` with no
   name and the INSERT seal would abort the command): 4d-ii — the service
   unit, never the migration unit (#556's review round 1, finding 3) —
   widens the kernel's `EventActor` from `Pick<Actor, 'actorId' | 'actorKind'>` to the
   FULL `Actor` — the subset existed so the envelope's two fields need not
   drag a name through a deep seam, and the envelope now records four — so
   `tsc` in `pnpm check` enumerates every emitter that hands `emitEvent`
   less; `AttributionActor` becomes the full attribution (`actorId`,
   `actorKind`, `actorRole`, `actorName` — `role` retired for `actorRole`,
   which for every human site is the same `user.role` the resolved `Actor`
   already carries), every constructing site passing the resolved `Actor` it
   already holds, and the two system-kind sites —
   `commercial-activation.service.ts::resolveOperator` and the
   `commercial-reevaluate` CLI — carrying the operator's display name from
   the orgs identity contract (`OrgsParticipant.resolveUserIdentity` widened
   to return `name` beside `id`) with the role the attribution guard
   resolved; threaded THROUGH the participant seams, never an orgs lookup
   inside the platform (the kernel resolves no identity). P37's arm drives
   each seam after the trailing seal — a PO issue and amendment, a labour
   PO, an inventory receipt, a measurement, the activation CLI and the
   re-evaluate CLI — and asserts the pair on every `commercial.money_moved`
   envelope, RED at base where the seam drops the name — read through
   the platform-owned `platform_tx_event(projectId, eventType, entityType,
   entityId)` (the rows of the current transaction; the same kernel read
   shape as the receipt binding); exactly ONE `DecisionEvent` audit row of EACH kind the table below
   lists for the transition, for the decision, with `actorId` the same actor
   and `actorRole`/`actorName` the fact's frozen pair (a decisions-owned
   row) — WHERE the fact carries one: a fact whose frozen pair is NULL is
   representable only through the drain, before 4d-iii's trailing seal
   requires it, and for such a fact BOTH the audit row's and the envelope's
   attribution bind `actorId` alone (#557's review round 1, finding 4: the
   previous release's no-chain approve writes the audit row's `actorRole`
   and leaves the revision's `approvedByRole` NULL, so an unconditional
   equality would abort every legacy approval through the drain; the NULL
   branch is stated once, for every fact with a frozen pair, and closes when
   4d-iii makes a NULL pair unrepresentable on new rows — P42's arm drives EVERY
   pre-4d-ii-shaped live writer — the approval, the standard request, the
   withdrawal, the consultation request and response — through the 4d-i
   seals and asserts each commits, then the same shapes after 4d-iii and
   asserts each is refused where the trailing seals require what it lacks); and, for a
   transition that owes a feed row, exactly ONE `Notification` for the
   project whose `eventId` names that event, whose `decisionId` is the
   decision, and whose `kind` equals that event's `eventType` — read through
   the platform-owned `platform_tx_notification(projectId, eventId)`, the
   current transaction's feed rows bound to that event (#555's review round
   1, finding 1: the feed table is platform-owned, so the decisions seal
   calls the kernel's contract exactly as it calls `platform_tx_event`, and
   no decisions trigger selects the platform's table). Zero of any
   part is refused; two of any part is refused; a part naming another
   decision, actor, event or kind is refused. **And the pairing holds in the
   CONVERSE direction for every sealed event type** (#555's review round 2,
   finding 2, stated for the membership event in §A.2 and applied here to
   the decisions-owned types, since a standalone `decision.approved` with no
   transition would fold into `decisions.inbox` an approval the register
   never recorded): the platform's generic pairing mechanism of §A.2 — the
   `DomainEventPairingClaim` register, the `platform_claim_event_pairing`
   primitive and the kernel-owned `DomainEvent_t4d_pairing_claimed` seal;
   no decisions trigger is installed on the kernel table (#568's review
   round 1, finding 2) — with the catalog's `pairingRequired` flag set over
   exactly the types the table below lists, each event CLAIMED by the
   decisions-owned seal of its paired fact after that seal has verified the
   event through `platform_tx_event`, every arm below attributed to "the
   converse" being an arm of that claiming seal and the kernel demanding
   only the claim — the two DELIVERED consultation types included, since the uniform
   seventh obligation admits no fact whose effect is left to the service
   (#561's review round 1, finding 3: a hand-run `DecisionConsultation` or
   response satisfying the delivered seals committed without its
   `decision.consultation_requested`/`responded` event, so it existed
   without invalidation, push or projection refresh; both facts now
   require their same-transaction event naming the consultation through
   `platform_tx_event` — its intent's push TARGETED at the fact's audience:
   the request's `targetUserId` equal to the frozen `consulteeUserId`, the
   response's equal to the fact's `requestedById` with `roles` bound to the
   frozen requester role (#562's review round 1, finding 5: an event naming
   the consultation but targeting another user would have passed the
   complete-effect seal and been cancelled at claim, so the real consultee
   or requester received nothing) — and the kernel refuses the unclaimed
   event, the event without its fact
   — sealed in 4d-i without a drain concern, because the delivered 4c
   service already emits both events inside the fact's transaction) —
   reading only decisions-owned tables and the row it is handed (the
   `phase6_t4b2_membership_guard` shape), requires at commit exactly one
   same-transaction FACT of the kind the transition writes, for the event's
   decision, in the event's project: `decision.awaiting_countersign` — a
   `DecisionApprovalRevision` born `finalized = false`, OR the ordered
   consumer's re-emit, which is bound to its CROSSING and not merely to an
   audit row (#558's review round 1, finding 1: a direct writer could set
   `renotified = true`, insert the audit row and commit a standalone demand
   the relay sends, outside the push-shape seal): the payload carries
   `renotified = true`, `crossingEventId` and `transitionId`; the kernel
   read `platform_event(projectId, eventId)` — a platform contract returning
   a COMMITTED event's type, entity, position and payload, the committed-row
   sibling of `platform_tx_event` — proves the crossing is a
   `membership.standing_changed` event of this project whose payload names
   that `transitionId`, at a position EARLIER than this event's, AND that
   it is the 0 → 1 ACTIVATION crossing — its payload `activeCount = 1` and
   `to` an active architect membership (#558's review round 2, finding 1: a
   legitimate 1 → 2 activation, which the consumer classifies `noop`, could
   otherwise be cited), AND that the decision's LATEST
   `decision.awaiting_countersign` demand sits AT OR BEFORE that crossing —
   read through the kernel's committed-row sibling
   `platform_latest_event(projectId, 'Decision', decisionId,
   'decision.awaiting_countersign', before := NEW."streamPosition")` — the
   latest demand at a position STRICTLY BEFORE the event being judged,
   since the deferred trigger runs inside the inserting transaction and an
   unbounded lookup would select the re-emitted demand itself and refuse
   every valid re-emission (#562's review round 1, finding 6) — the
   handler's decisive predicate
   mirrored by the seal (#560's review round 2, finding 3: a decision
   approved AFTER an otherwise-unused activation Q could cite Q and commit a
   second demand the ordered handler would have skipped because the real
   demand postdates Q); exactly one
   same-transaction `countersign_renotified` audit row names the same
   crossing and transition — **and that audit row is this branch's PAIRING
   CLAIMANT** (#572's review round 4, finding 5); the decisions-owned partial UNIQUE index on
   `DecisionEvent (decisionId, (payload->>'crossingEventId')) WHERE type =
   'countersign_renotified'` makes a second demand for one (decision,
   crossing) unrepresentable; and the converse applies to this branch the
   SAME push-shape check the transition seal applies to the provisional
   approve — the intent's push present with the catalog's constant body and
   `targetUserIds` DISTINCT and EQUAL, as a set, to the active architects
   `platform_role_holder_user_ids` resolves at commit — the producer
   persists the CANONICAL array, sorted and distinct, and the seal refuses
   any array with a repeated element before it compares sets (#565's
   review round 1, finding 3: set-equality alone admitted `[A, A]`, and the
   worker sends once per listed element, so one architect received the
   demand twice) — (a stale re-emit whose
   audience is empty is refused here exactly as the handler's
   current-standing judgement prevents it from being attempted); `decision.approved` /
   `decision.reapproved` — tied to the EXACT finalized revision, which the
   event's payload NAMES from 4d-ii: every emitter of these two types — the
   direct approve, the countersign, the `completed` resolution — carries
   `revisionId` in the payload, the correspondence table binds it to the
   paired fact's revision, and the converse resolves the finalizer through
   it (#557's review round 2, finding 2: the delivered payload carries
   option, material and `onBehalfOf` only, so with several revisions an
   older kinded green notice could have rendered the newest head's approver
   and the "exact revision" binding had nothing durable to bind on; a kinded
   green notice renders the approver facts from the revision its event
   names, never the head) — EITHER a same-transaction
   `DecisionApprovalRevision` with that id (the direct no-chain approve
   inserts one — the delivered approve writes it in-transaction) OR, since a
   countersign and a `completed` stranded resolution FLIP the existing
   provisional revision's `finalized` and insert no row (#557's review round
   1, finding 1), a same-transaction `DecisionCountersign` fact or a
   `completed` `DecisionStrandedResolution` fact naming that revision, whose
   `finalized` flipped in this transaction (the row's `xmin` current and
   `finalized = true`) — one of the three, never none, never two; a
   previous-release event through the drain carries NO `revisionId`, and for
   it the converse falls back to the same-transaction revision insert for
   the decision — the only finalizer a pre-4d-ii process can produce — until
   4d-iii's trailing arm requires the payload field on every new event of
   the two types; `decision.change_requested` — a
   `ChangeRequest` row; `decision.forwarded` — a `DecisionForward` fact;
   `decision.change_withdrawn` — a `change_withdrawn` audit row AND the
   decision's `ChangeRequest` row written to `withdrawn` AND the `Decision`
   row landed `approved` in the same transaction (the delivered
   `withdrawChange` does all three under the readiness lock).

   **The closer is frozen exactly as the requester is** (#572's review round
   4, finding 2). `ChangeRequest` gained a frozen `requestedByRole`/
   `requestedByName` pair and nothing for the actor who CLOSES it, so a
   hand-run bundle could set a truthful `resolvedById` and still stamp an
   arbitrary role and name on the `decision.change_withdrawn` event envelope
   and its audit row — permanently, both being append-only. The row therefore
   gains `resolvedByRole`/`resolvedByName`, written with `resolvedById` and
   immutable with it, judged at the withdrawal exactly as obligation 3 judges
   every frozen pair (the role the actor HOLDS by
   `platform_user_holds_role`, the account's `platform_user_display_name`)
   — **and through the window that `pmc` arm takes the RACE-FREE authority
   derivation, not the fanned-out register**, because a membership-less
   owner/admin the delivered `withdrawChange` authorizes would otherwise be
   refused by this new validation exactly as the standard REQUEST arm above
   would have been (#572's review round 5, finding 3). 4d-iii re-points both
   in the same transaction as the rest —
   and obligation 7's correspondence for this type binds BOTH effect records
   to that pair rather than to `actorId` alone. This is the same rule the
   `countersign_rejection` closure already follows through its resolution
   fact; the standard origin had no closure fact and so had nowhere to put
   it, which is why it was missed. P33 gains the forged-closer arm: a bundle
   citing a real `resolvedById` with a role or name the registers do not give
   that user is refused at commit.

   **And the closure carries its OWN receipt, because the row's only
   `sourceCommandId` is the REQUEST's** (#572's review round 5, finding 5).
   Freezing the resolver pair proves the closer's attribution is not forged;
   it does not prove a `decisions.withdrawChange` command was ever reserved
   and completed, because the provenance column on this row was written by
   the earlier `requestChange` and a withdrawal never touches it. A
   database-role writer can therefore set a TRUTHFUL `resolvedById` with the
   pair the registers do give that user, flip `change → approved`, and append
   the matching event and audit row — satisfying every seal listed above
   while reproducing none of the withdrawal ledger protocol. The
   `countersign_rejection` closure is not exposed to this, and the reason is
   the shape: it closes through the `DecisionStrandedResolution` FACT, which
   carries its own required `sourceCommandId`. The standard origin closes
   with no fact, so it needs the column the fact would have carried:
   `resolvedByCommandId`, written with `resolvedById` and the resolver pair
   and immutable with them, project-contained composite FK to
   `CommandExecution(projectId, id)`, its own `(projectId,
   resolvedByCommandId)` one-use UNIQUE, and — like every provenance column
   this plan adds — nullable through the drain and REQUIRED by 4d-iii's
   trailing seal on every CLOSURE.

   **"On every closure" is the row LEAVING `status = 'open'`, not the resolver
   column being set** (#572's review round 12, finding 1). The two sentences
   describe the same statement for the two writers this service ships, which is
   why the difference was invisible for four rounds — both write `status`,
   `resolution`, `resolvedById` and `resolvedAt` in one `updateMany`. They are
   not the same rule against the writer this plan exists to stop: a closure that
   sets `status` and omits the resolver is still a closure, still leaves the
   decision unrecoverable in `change`, and a seal keyed on the resolver column
   never sees it. The seal is keyed on the transition that IS the act; the
   resolver columns are part of what the act OWES, never the trigger for asking.

   **ITS WRITERS ARE DERIVED FROM THE COLUMN IT QUALIFIES, NOT LISTED**
   (#572's review round 6, finding 1). Round 5 introduced this column and then
   named `decisions.withdrawChange` as its writer — a hand-written set, in the
   same round whose audit concluded that a rule needs a reader rather than a
   list. It was wrong within one round: `DecisionsService.approve` ALSO closes
   the open request on a mandatory re-approval, writing `resolvedById` in the
   `prior === 'change'` branch (`decisions.service.ts`), so a required closure
   provenance would have rolled back an ORDINARY approval from `change` after
   4d-iii — for either origin, since that branch closes whichever single open
   request exists.

   So the rule is stated over the ACT and not over the column (#572's review
   round 12, finding 1 — round 6 derived the writer set from `resolvedById`,
   which is the same column-keyed shape the seal itself carried, and it is the
   ACT that owes provenance): **`resolvedByCommandId` is owed by EVERY command
   that CLOSES a change request — every writer that moves `status` out of
   `'open'` — and a command that closes a request without reserving its own
   receipt is a defect.** The derived set is unchanged today, because both
   delivered closures write the resolver as well; the rule now also catches a
   writer that closes WITHOUT one, which the column-keyed derivation admitted
   silently. Derived today, as
   a check on the derivation rather than as the authority: the delivered
   writers of `resolvedById` are `decisions.withdrawChange` (the withdrawal)
   and `decisions.approve` (the re-approval closure) — TWO, and both are
   ledgered commands that opt into `synthesizeKeyWhenAbsent: true`, so the
   obligation-6 derived set becomes TEN. A reader who finds a third writer of
   `resolvedById` in the delivered service is holding the correction.

   **AND RECORDING A RESOLVER OWES THE WHOLE CLOSURE SET, NOT WHICHEVER PART A
   FINDING NAMED** (#572's review round 7, findings 1 and 2). Round 6 derived
   the writer SET correctly and then carried exactly one of the obligations
   that attach to being in it — the provenance column — leaving the other two
   with the withdrawal alone, so an ordinary re-approval still rolled back. The
   obligations are stated here ONCE, as a set every writer of `resolvedById`
   inherits whole:

   1. the frozen `resolvedByRole`/`resolvedByName` pair, judged exactly as
      obligation 3 judges every frozen pair (the delivered `approve` closure
      writes `resolvedById` alone today, so 4d-ii teaches it the pair as it
      teaches the withdrawal);
   2. `resolvedByCommandId`, the closure's own receipt; and
   3. that receipt BINDING — which is finding 2, and which the previous
      paragraph's `resultRef` rule does not yet reach.

   On (3): `phase6_t4d_provenance_bound` admits a `resultRef` naming the row
   itself or the bundle's PRIMARY fact — the fact §A.3 derives as present on
   every instance of the branch, which for the two branches that reach this
   rule is the reject-back/forward-on REQUEST and the RESOLUTION row. A
   closure has neither shape.
   BOTH its writers complete their receipts with `resultRef: decisionId`
   (`decisions.service.ts` — `approve` and `withdrawChange` alike), and neither
   the `ChangeRequest.id` nor the revision id equals a decision id, so writing
   the column without extending the binding leaves every closure failing
   provenance validation. **Codex's finding named `approve`; the sweep over the
   derived writer set found `withdrawChange` in the same state**, which is the
   whole reason the set is derived rather than visited.

   So the binding is defined in terms of the result these commands ALREADY
   produce rather than by changing what they return: `phase6_t4d_provenance_bound`
   admits, for a `ChangeRequest` CLOSURE, a `resultRef` naming the
   `decisionId` of the row being closed, when the same transaction cites that
   receipt on the closure and the decision's own transition. That is a third
   admitted shape beside "the row" and "the bundle's primary", added because a
   closure is neither: it mutates an existing row rather than creating the
   fact its command is about, and the thing its command IS about is the
   decision. Deliberately NOT done: changing `approve`'s or `withdrawChange`'s
   `resultRef` to name the `ChangeRequest`, which would re-point the receipt of
   a command whose subject is the decision — and, for `approve`, would also
   move the delivered approval-revision binding that already rests on it.

   P33 gains the NO-RECEIPT hostile arm: a bundle with a truthful resolver
   pair, a real restoration and no reserved withdrawal receipt is refused at
   commit — RED against the pair-only rule, which that bundle satisfies. P42
   gains the REAPPROVAL arms after the trailing seals: the shipped
   `decisions.approve` driven from `change` COMMITS with a non-NULL
   `resolvedByCommandId` on the closed request, for a `standard` request and
   for a `countersign_rejection` one — RED against a writer taught only the
   withdrawal path, where an ordinary approval rolls back at the seal. **And the
   closure and the restoration are one bundle in BOTH directions** (#558's
   review round 1, finding 2: requiring the closure alone let a direct
   transaction close the sole open request, append the audit row and the
   event, and leave the decision in `change` — stranded, with nothing to
   withdraw and no state to approve from): a decisions-owned DEFERRED
   trigger on `ChangeRequest` — `ChangeRequest_t4d_paired`, the ONE deferred
   pairing seal on the table, whose only admitted bypass is the seed's DL-003
   plant (§D 4d-iii; #568's review round 2, finding 1) — requires, for a
   `standard` request written to `withdrawn`, the same-transaction `Decision` row (own table, `xmin`
   current) landed `approved` and the same-transaction
   `decision.change_withdrawn` event through `platform_tx_event`; the
   approved-entry seal's restoration arm already requires the
   same-transaction closure; neither half commits without the other. **And
   the OPENING is one bundle in both directions too** (#568's review round
   1, finding 3: the pairing column covered `countersign_rejection` alone,
   so after the sole architect left an `awaiting_countersign` decision a
   database-role writer holding a valid `requestChange` receipt could insert
   a `standard` request with its event and audit row WITHOUT moving the
   decision, and that row occupied `ChangeRequest_one_open_per_decision` so
   the stranded `returned` resolution could never create its rejection
   request): the same decisions-owned DEFERRED trigger requires, for a
   `standard` request INSERTED open, the same-transaction `Decision` row
   (own table, `xmin` current) moved `approved → change`, and the
   approved-entry seal's `approved → change` arm requires exactly one
   same-transaction open `standard` request — the delivered `requestChange`
   performs the CAS and the insert together under the readiness lock, so
   the previous release is compatible through the drain; the planted
   request is refused at commit and can occupy nothing, and a transition
   without its request is refused the same way. **And
   the `open → resolved` closure pairs with its REAPPROVAL the same way**
   (#558's review round 2, finding 6: the reapproval path closes its request
   `resolved`/`reapproved`, not `withdrawn`, so a direct writer could
   resolve the sole open request and leave the decision in `change`, or
   reapprove and leave the request open): the same decisions-owned deferred
   trigger requires, for a request written to `resolved`, the same-transaction
   `Decision` row landed `approved` (no chain) or `awaiting_countersign`
   (chain) with its same-transaction revision and event; and the
   reapproval's entry seal — the approved-entry seal without a chain, the
   awaiting-entry seal with one — requires the same-transaction closure of
   the open request; neither half commits alone. An event of a sealed type without its fact is refused at commit;
   the forward direction (the fact without its event) is the obligation
   above; a hand-run bundle therefore reproduces BOTH or commits neither. There is ONE emitter — the
   service — for every writer at every instant; a hand-run bundle that
   reproduces the ledger protocol reproduces every IDENTITY the seals bind
   (receipt, fact, transition, a canonically enveloped event, an audit row
   and a feed row that correspond on every named field) or does not commit
   — and the free content it writes beyond those fields is trusted as the
   boundary above states; nothing is
   emitted from PL/pgSQL, no twin of `emitEvent` or of the notification
   helper exists, and the event's DELIVERY OBLIGATIONS are demanded in the
   authorizing transaction, never deferred to a background pass (#558's
   review round 1, finding 7: leaving a hand-written event's delivery rows to
   `expandMissingDeliveries` meant that with `OUTBOX_RELAY_AUTOSTART=false`,
   or the relay down, a committed transition had no durable effect — no
   socket, push or projection work existed for it): the platform-owned
   DEFERRED constraint trigger `DomainEvent_t4d_deliveries` requires at
   commit, for EVERY row of the persisted `OutboxConsumerCatalog` that is
   ACTIVE at that commit, exactly one same-transaction
   `OutboxDelivery(eventId, consumer)` row for the new event whose action is
   `dispatch` or `noop` according to a PERSISTED rule the catalog row
   carries — `dispatchRule` (`all`: every event dispatches; `invalidate`:
   dispatch iff the intent's `invalidate`; `push`: dispatch iff the intent
   carries a push; `types`: dispatch iff the event's type is in the row's
   `subscribedEventTypes`) — so the seal judges the rows against kernel
   truth and reproduces no consumer logic (a row for a consumer that
   deactivated between the emitter's read and the commit is admitted — the
   seal REQUIRES rows for the active set, it never forbids one — but EVERY
   delivery row that exists, active consumer or not, must carry the action
   its consumer's persisted rule derives for that event, judged by the
   row-level `OutboxDelivery_t4d_bound` at insert; #563's review round 1,
   finding 3: an unvalidated row planted for an inactive consumer would have
   survived reactivation, since `expandMissingDeliveries` skips an existing
   `(eventId, consumer)` row, and made the ordered cursor skip a required
   handler or run a spurious one). **The rules are sealed
   evidence, not startup state** (#558's review round 2, finding 7): they
   are frozen by `OutboxConsumerCatalog_t4d_rules` — an UPDATE of the rule
   columns refused outside the `SET LOCAL` gate — and `syncConsumerCatalog`
   VERIFIES at startup that the persisted rule equals the compiled contract,
   refusing the process on drift exactly as it refuses a `catalogVersion`
   mismatch today.

   **A row's BIRTH carries its rule; the migration owns every rule that already
   EXISTS** (#572's review round 24, finding 2). An earlier draft said the
   versioned catalog-data migration is the ONLY writer and
   `syncConsumerCatalog` never writes a rule, and that contradicts the
   delivered function, which is the supported CREATOR of a compiled consumer's
   catalog row: `registry.ts:212-236` creates a missing row from the compiled
   contract's `{consumer, consumerKind, consumerEffect, catalogVersion}`, and
   the shipped suites use exactly that path to bring consumers into existence
   at runtime — `outbox-scanner.test.ts:46` for `FILTERED` and its six `AD_HOC`
   consumers registered inside individual tests (`:101`, `:148`, `:170`, …),
   whose `deliveryFor` is an inline lambda no migration could ever have
   pre-registered. Under the earlier wording those creates either fail on a
   required rule column or write a row with no rule that startup verification
   then rejects, so the plan would have broken delivered suites and every
   bootstrap-created consumer, P-A11's included.

   The correction is to say what the function already does, one column family
   wider: **an INSERT takes its rule from the COMPILED contract**, in the same
   act and from the same source as `consumerKind`, `consumerEffect` and
   `catalogVersion`, which is why no drift can be introduced by it — the value
   written is the value verification compares against. What the migration owns
   is the rule of a row that already exists: a CHANGED rule is a contract
   change and needs its versioned migration, never a silent overwrite, which is
   the delivered `assertMatches` discipline (`registry.ts:213-220`) extended to
   the new columns rather than a new rule. The `OutboxConsumerCatalog_t4d_rules`
   freeze is therefore on UPDATE, not INSERT, and the gate admits the
   migration's rewrite alone. The companion document's catalog-INSERT trigger is
   unaffected — it appends the new row's activation baseline whoever inserts it,
   which is now true of the rule too: both travel with the row's birth. **The obligation set is the ACTIVE
   set, judged from an append-only fact — never a timestamp** (#560's
   review round 1, findings 1 and 2: `registeredAt` as the cutoff was a
   plain writable column, so a direct writer could move it past the event
   and commit without the consumer's row; and a consumer set inactive for
   event N and reactivated for N + 1 would have had N excluded from
   expansion "because it postdates registration", stalling its ordered
   cursor at N forever): `OutboxConsumerCatalog.active` is the MIRROR of the platform-owned
   append-only attributable `OutboxConsumerActivation` register — **specified
   in this unit's COMPANION DOCUMENT,
   `docs/superpowers/plans/2026-09-09-outbox-consumer-activation.md`, which is
   part of THIS review unit and lands in the same commit as this plan.** That
   document owns the register, its seals, its baseline backfill, the mirror's
   sole writer, and the `outbox:consumer` operator protocol with its retry
   identity; it carries forward every finding this material has drawn — #560
   rounds 1–2, #561 round 1, #572 rounds 8, 9, 10 and 12, and its own rounds
   1–4, raised against it during the interval when it was reviewed separately
   as PR #580. **There is no merge ordering between the two documents and no
   precondition either way** — a single unit cannot land half of itself: the
   obligation set below is the ACTIVE set, and the ACTIVE set is what that
   register defines. Nothing about the register is restated here, so the two
   cannot drift.

   `expandMissingDeliveries` keeps its DELIVERED contract
   — for every currently-active consumer, every event that lacks its row,
   whatever the reason (an event older than the consumer's first
   activation, the events of a deactivated interval once the consumer is
   reactivated, a crash between event commit and row creation) — deriving
   each row's action from the SAME persisted rule, so an ordered cursor
   never waits at a position without a row, and the 4d-iii activation of
   `decisions.effects` fills its whole history with `noop`/`dispatch` rows
   on the next relay pass (the P38 activation arm, formerly the
   registration arm). **The rows are a pure function of the event and the
   persisted catalog, so EVERY emitter writes the same rows — a booted
   API, a standalone CLI, a hand-run bundle** (#560's review round 1,
   findings 4 and 6: `materializeDeliveries` derived its row set from the
   PROCESS-LOCAL registry, so `commercial-reevaluate.cli.ts` and
   `capability.cli.ts`, which construct Prisma and their service graph
   without `OutboxBootstrap`, materialized nothing and their
   `commercial.money_moved` events would have been refused by the seal; and
   nothing bound a `dispatch` row's `payload`/`subject` to the immutable
   intent or froze them afterwards, so a correctly sealed event naming the
   full architect set could carry a delivery rewritten to one chosen
   architect or a foreign body): from 4d-ii the platform's
   `deliveryRowsFor(event, catalogRows)` computes the row set from the
   persisted ACTIVE rows and their rules, and a `dispatch` row's
   `payload`/`subject` as the PROJECTION of the immutable event —
   `{body, roles, targetUserId, targetUserIds}` copied from
   `dispatchIntent.push` and `subject = entityId` for the push consumer, no
   payload for the socket and the ordered consumers, which read the event
   by position — the consumer contract's `deliveryFor` retired in favour of
   the persisted rule (the compiled registry's rules being exactly what
   `syncConsumerCatalog` verifies the persisted ones against);
   `materializeDeliveries` and `expandMissingDeliveries` both call it, so a
   process that booted no registry writes the same rows a booted API does;
   `deliveryRowsFor` locks EVERY `OutboxConsumerCatalog` row `FOR SHARE` —
   active and inactive alike — BEFORE it filters by `active`, and the
   event's transaction holds those locks to commit, so an activation append
   — which takes its row `FOR UPDATE` — either committed before the
   obligation set was read or waits for the event's commit (#567's review
   round 1, finding 3: locking only the rows the `active` filter returned
   left an inactive consumer's row unlocked, so an activation could take
   it, flip it and commit between the event's read and its commit, and the
   event committed with no row for a consumer active at its commit), and
   the deferred seal re-reads under the same locks (#561's review round 2, finding 5: an unlocked read
   let an activation commit between the event's check and its commit,
   leaving an event with no row for a consumer active at its commit — the
   exact window the seal exists to close).

   **Row locks cannot lock a row that does not exist yet, so REGISTRATION needs
   its own barrier** (#572's review round 24, finding 5). Both prior fixes here
   — #567's round 1 finding 3 and #561's round 2 finding 5 — closed the race
   against ACTIVATION of an EXISTING catalog row, and `FOR SHARE` over every
   row is a complete answer to that. It is no answer at all to a consumer
   whose row is INSERTED and committed between the event's obligation read and
   the event's commit: there was nothing to lock, the locked set contains no
   such row, and PostgreSQL has no predicate lock that would have covered it. A
   brand-new consumer is created active — `syncConsumerCatalog` is the delivered
   creator and the shipped suites call it at runtime — so the event can commit
   owing a delivery to a consumer that was active at its commit, or, if the
   deferred seal's re-read happens to see the new row, be refused at commit for
   an obligation it could not have known about. Either outcome is the thing the
   seal exists to prevent.

   So event authoring and catalog INSERT take ONE shared barrier — a
   transaction-scoped advisory lock on a single catalog-registration key, taken
   in SHARE mode before the obligation set is read and in EXCLUSIVE mode by any
   `OutboxConsumerCatalog` INSERT — which serializes a registration against
   every in-flight event without serializing events against each other.

   **BOTH halves are taken in the DATABASE, by the seals, not by the callers**
   (#572's review round 26, finding 1, completing round 25's finding 7). Round 25
   moved the EXCLUSIVE half into a trigger and left the SHARE half assigned to
   `deliveryRowsFor` — a TypeScript helper — which closes the race only for
   writers that go through the platform's own emitter. A direct `DomainEvent`
   writer with a receipt inserts its bundle without calling that helper at all:
   the deferred `DomainEvent_t4d_deliveries` seal scans the catalog holding no
   shared key, a registration takes the UNCONTENDED exclusive key and commits,
   and the event then commits owing that consumer nothing. Half a barrier in the
   database and half in the application is not a barrier — it is the same
   *cover the OPERATION, not the caller* rule this plan minted in round 12,
   applied to a lock instead of a column. So `DomainEvent_t4d_deliveries` takes
   the registration key in SHARE mode ITSELF, at the head of its deferred body,
   before it scans; `deliveryRowsFor` may still take it early for lock-ordering
   hygiene, and the advisory lock is reentrant so a second acquisition in the
   same transaction is free. The seal is the enforcement point, the helper is a
   convenience, and every writer — emitter, migration, direct — is serialized by
   the same object.

   **The EXCLUSIVE half is installed by a named trigger, not left to the
   inserting caller** (#572's review round 25, finding 7). Naming a key and
   assigning its acquisition to nobody is this plan's own root cause — *a
   contract that names no installer is not installed* — and it would leave the
   race exactly where it was for any writer that does not volunteer: a
   database-role writer, or a migration, inserting a default-active row while an
   event holds the shared key over the catalog it already read. So
   `OutboxConsumerCatalog_t4d_registration_barrier`, a BEFORE INSERT trigger on
   `OutboxConsumerCatalog`, takes `pg_advisory_xact_lock` on the registration key
   in EXCLUSIVE mode for EVERY insert — `syncConsumerCatalog`'s creates, the
   catalog-data migration's, and any direct writer's alike — and it is named in
   4d-ii's staged inventory beside the delivery seals rather than only here. It is taken BEFORE the per-row `FOR SHARE` locks,
   so the order is registration key → catalog rows, one direction, and it joins
   the ONE canonical lock order §A.3 states rather than sitting beside it.

   P38's barrier probes
   event-vs-activation in both orderings, the read → activation →
   event-commit interleaving against an inactive row included, **and gains the
   event-vs-REGISTRATION arm** (round 24, finding 5): an event's obligation read,
   then a new active consumer registered and committed, then the event's commit
   — the event either carrying that consumer's row or the registration having
   waited, never the event committing without it, in both orderings and RED
   against the row-locks-only design, which admits the gap because the row did
   not exist to be locked; **driven twice, once through the platform
   emitter and once by a DIRECT receipt-backed `DomainEvent` writer that never
   calls `deliveryRowsFor`** (round 26, finding 1) — the second RED against a
   barrier whose SHARE half lives in the helper rather than in the seal;
   the platform-owned BEFORE INSERT trigger `OutboxDelivery_t4d_bound`
   requires EVERY row's `deliveryAction` to equal the action its consumer's
   persisted rule derives for the event, whatever the consumer's activation
   state, and a `dispatch` row of a push-family consumer to carry exactly
   that projection of its event's intent (`body` equal, `roles` equal,
   `targetUserId` equal, `targetUserIds` equal element-for-element to the
   intent's canonical sorted, distinct array where the intent carries
   it and absent where it does not — the previous release's
   `{body, roles, targetUserId}` shape therefore passes for every intent it
   can emit) and `subject = entityId`; and `OutboxDelivery_t4d_frozen`
   refuses any UPDATE of `eventId`, `projectId`, `streamPosition`,
   `consumer`, `consumerKind`, `payload` or `subject` and admits `deliveryAction`
   to change only `dispatch → noop`, and only through the THREE
   relay-owned transitions the delivered code performs — the 4a
   cancellation mark (`cancelledAt` set in the same statement, payload
   preserved), the leased-cancel COMPLETION (`dispatchExternal` neutralizing
   a row whose mark is ALREADY set, in its own later statement), and the
   pre-intent neutralization (`dispatchExternal` retiring a pending row
   whose event's `dispatchIntent` IS NULL, a legacy event with nothing to
   send) — #562's review round 2, finding 5: admitting only the
   same-statement mark would have made the relay's second update fail
   until the cancelled delivery dead-lettered — and admits `cancelledAt`
   ONLY as that NULL → timestamp write, in the mark's own statement or as the delivered
   mark-only arm on a row already leased or dead (status unchanged), never
   cleared and never rewritten (#561's review round 1, finding 4: a freely
   mutable mark let a direct writer suppress a legitimately leased push or
   un-cancel a stale one for a later redrive), leaving `status`, `attempts`,
   `nextAttemptAt`, `leaseOwner`, `leaseExpiresAt` and `lastError` as the
   only operationally mutable columns. **The seal, the rule columns, the
   activation register and the rewritten materialization ship TOGETHER in
   4d-ii** — the unit whose catalog-data migration writes the rules and
   whose service change rewrites the emitter — not in migration-only 4d-i,
   where the seal would have met the unchanged CLIs (finding 6) with no
   rule to judge by; 4d-i deploys dark and emits nothing 4d-specific, so
   nothing is lost by the move. A still-serving pre-4d-ii process through
   the drain writes its rows from its process-local registry, which the
   seal admits because the persisted rules are seeded from the same
   compiled contracts and the binding admits its payload shape, while
   `decisions.effects`, which that process does not know, is INACTIVE until
   4d-iii; a hand-run bundle writes the same rows or is refused.

   **The kernel seals its own envelope, so a module seal never has to** (this
   PR's review round 1, finding 2): the delivered event store is append-only
   (`20261015000000_phase2_event_envelope`'s BEFORE UPDATE OR DELETE trigger
   and attribution CHECK), but nothing judged an INSERT — a hand-run writer
   could insert at the stream's current `nextPosition` without incrementing
   the counter (the next `emitEvent` then fails the `(projectId,
   streamPosition)` uniqueness) or with an arbitrary `dispatchIntent` the
   relay's `expandMissingDeliveries` would trust. 4d-i installs the
   platform-owned BEFORE INSERT trigger `DomainEvent_t4d_envelope` requiring
   (a) POSITION: `NEW."streamPosition"` equals the project's
   `ProjectEventStream."nextPosition" − 1` AND that stream row was written in
   the CURRENT transaction (`xmin = txid_current()::text::xid`) — the
   increment-then-insert protocol `emitEvent` follows, so a writer that skips
   the increment lands on `nextPosition` (refused) or on an already-taken
   position (refused by the uniqueness), and a writer that increments once
   for two events has its second refused — AND the COUNTER'S OWN TRANSITION
   is sealed one-to-one with the events (#554's review round 2, finding 1:
   the final-value predicate alone admitted `nextPosition + 2` with one
   event at `nextPosition − 1`, and the skipped position would stall
   `dispatchOrdered`, which waits for the next expected position, and make
   every rebuild report a replay gap): the platform-owned
   `ProjectEventStream_t4d_allocation` BEFORE UPDATE trigger admits only
   `NEW."nextPosition" = OLD."nextPosition" + 1` (never a jump, never a
   decrement), and a DEFERRED constraint trigger on the same table requires
   at commit, for EACH increment, a same-transaction `DomainEvent` of this
   project at exactly `OLD."nextPosition"` — the position that increment
   allocated; with the envelope seal requiring every event to sit at an
   allocation of its own transaction, allocations and events are
   one-to-one and a gap, a double allocation or an event without its
   allocation is unrepresentable — and the counter row itself cannot be
   REPLACED to bypass its sole `+1` transition (#561's review round 1,
   finding 7: a direct transaction could delete a project's
   `ProjectEventStream` row, reinsert it at `nextPosition = N + 2` and
   insert one event at `N + 1`, no UPDATE trigger firing and the envelope
   check accepting the fresh row's `xmin`, leaving position N absent
   forever): `ProjectEventStream_t4d_no_delete` refuses DELETE except under
   the project-deletion cascade the `Project_t4d_deleting` flag marks,
   `ProjectEventStream_t4d_init` BEFORE INSERT admits only `nextPosition =
   0` for a project that has no `DomainEvent`, and
   `ProjectEventStream_t4d_no_truncate` joins `TRUNCATE_SEALS` (disabled by
   name in the sanctioned reset, which truncates the stream with its
   events); (b) INTENT: `dispatchIntent` is
   NOT NULL and corresponds to a PERSISTED catalog — the platform-owned
   `ExternalEffectCatalog(coverageVersion, effectKey, eventType, invalidate,
   pushRoles, pushFamily, frozenAudience, requiresPush, audience,
   pushBody, pairingRequired)` — the push-shape triple the evidence the
   envelope and transition seals below read, and `pairingRequired` the flag
   the kernel's pairing seal reads (§A.2; #568's review round 1, finding 2),
   seeded from the compiled `EXTERNAL_EFFECTS`
   entries like every other column and under the same tripwire (#560's
   review round 1, finding 3: the enumerated schema omitted them while the
   next paragraph read them) — **`pushRoles` is PERMISSION and
   `requiresPush` is OBLIGATION, and the seeding derivation must not
   conflate them** (#582's review round 2, finding 1, and the seeding defect
   implementing it exposed): `pushRoles` is the audience CEILING a key may
   ever reach, `requiresPush` is "the delivered service ALWAYS announces on
   this branch", which is the sense the drain table below already used of
   `decision.change_requested`. Seeding the second as `push !== null` made
   four keys claim an obligation the delivered emitter does not carry —
   `decision.published` (a RECORD publication pushes at nobody; the bell
   notice is the announcement), `activity.created` and `inspection.created`
   (the participants initialise a row for a foreign command and announce
   nothing) and `inspection.approved` (an approval closing an activity
   announces through the activity sign-off) — so the envelope seal below
   would have refused those four live emit paths at INSERT on 4d-i's deploy.
   The first answer was a per-key exception, `pushOptional`, with
   `requiresPush` deriving as `push !== null && !pushOptional`. **That answer
   was wrong and is withdrawn** (#582's review round 13, finding 3 and round
   18, findings 1–3): the obligation belongs to a BRANCH and `requiresPush`
   to a KEY, so exempting the silent branch released the announcing one with
   it — an approvable publication could omit its decider demand, an ordinary
   checklist creation its engineer notice, an ordinary approval its
   contractor/client announcement, each still passing the envelope seal.
   **A branch that does not announce gets its own `push: null` KEY**, the
   four of them being `activity.created.init`, `decision.published.record`,
   `inspection.created.init` and `inspection.approved.closing`, and
   `requiresPush` is simply `push !== null` again. `buildDispatchIntent`
   refuses a missing push on an obliged key with NO exemption, so the two
   ends of the rule agree and the type system keeps them agreeing. And the
   `audience` shape follows PERMISSION, never obligation — keying the CHECK
   to `requiresPush` would leave those same four families' push shape
   unjudged, `decision.published`'s 4b decider narrowing among them — primary key `(coverageVersion,
   effectKey)`, whose rows are written ONLY by migrations under a `SET LOCAL
   vitan.phase6_4d_catalog = 'on'` gate (the 4c-iii-r mistake-proofing
   shape), DELETE refused and UPDATE refused except the ONE gated
   retirement stamp below, `ExternalEffectCatalog_t4d_no_truncate`
   in `TRUNCATE_SEALS`: the intent's `(coverageVersion, effectKey)` names a
   row — locked `FOR SHARE` before it is read, so the gated retirement
   stamp's `FOR UPDATE` orders deterministically against every insert and
   an event cannot commit on an intent retired between its check and its
   commit (#561's review round 2, finding 6) — whose `retiredAt` IS NULL,
   that row's `eventType` equals `NEW."eventType"`, its `invalidate` equals
   the intent's, a push is present only where `pushRoles` is non-null AND
   PRESENT wherever the row's `requiresPush` is true (#561's review round
   2, finding 2: presence was demanded only of the two frozen-audience
   families, so a hand-run no-chain approval could seal a `noop` push row
   where the delivered service always announces), with the row's
   `audience` deciding its shape — `broadcast` (the intent's `roles` EQUAL
   `pushRoles` as a set: `decision.approved`/`reapproved`, the delivered
   emitter's own shape), `targeted` (a `targetUserId` present, or `roles` a
   non-empty subset naming the actual decider — the delivered 4b
   narrowing: `decision.published` and the two consultation families) or
   `frozen` (the rule below) — both columns seeded from the compiled
   catalog under the tripwire with NO default, so every pushing family
   declares them; and `targetUserIds` only where `audience = 'frozen'`;
   and (c) ATTRIBUTION as the delivered CHECK already states. **And for the two frozen-audience families the TRANSITION
   seal binds the push to what the transition OWES, not only to what the
   catalog permits** (#554's review round 2, finding 2): the catalog row
   carries `requiresPush` and the family's constant, decision-free `pushBody`
   (the bodies are generic by construction — "a decision awaits your
   countersign", "a decision has been forwarded to you"), and the
   decisions-owned correspondence check requires the same-transaction
   `decision.awaiting_countersign` or `decision.forwarded` event's intent to
   carry a push whose `body` equals that constant and whose `targetUserIds`
   is DISTINCT and EQUALS, as a set, the audience resolved at commit under
   the readiness lock the transaction holds (the producer persisting the
   canonical sorted, distinct array; a repeated element refused — #565's
   review round 1, finding 3): for the countersign demand, every active
   architect's user id from the kernel read
   `platform_role_holder_user_ids(project, role)` over `ProjectUserStanding` (the participant's
   `effectiveRoleHolderUserIds` becomes a wrapper over this one SQL
   implementation, so service and seal resolve the same set — for
   `architect` from 4d-ii, for `pmc`/`client` once `rollout.phase6_4d`
   reads `open`, every frozen-audience seal being reachable only then: the
   window rule of §A.2; an empty set is
   refused — an awaiting entry requires an active chain); for the forward,
   the installed holder's user (`platform_membership_active_user`) or the
   holder role's set. A push omitted, a subset, a superset or a foreign body
   is refused at commit. **The repository's deliberate raw event inserts
   move to the sealed allocation path or a NAMED bypass** (#555's review
   round 1, finding 5): `event-envelope.test.ts` inserts raw `DomainEvent`
   rows to probe the delivered envelope, and `upgrade-proof.sh` (and
   `outbox-migration-abort-proof.sh`) plant legacy events the same way; the
   envelope seal would refuse them before they tested what they exist to
   test. 4d-i's PR gives the suites a shared `insertRawEvent` fixture that
   allocates the position through `ProjectEventStream` (`+1`, the sealed
   protocol) and copies the persisted catalog's intent for a named key, so
   the delivered envelope arms pass the seal unchanged and the suite's NEW
   arms probe the seal itself; a legacy-shape plant — pre-4d by definition —
   disables `DomainEvent_t4d_envelope`, `ProjectEventStream_t4d_allocation`
   AND the kernel's pairing seal `DomainEvent_t4d_pairing_claimed` (and,
   from 4d-ii, `DomainEvent_t4d_deliveries`) by name inside its plant
   transaction and re-enables them after, an explicit bypass the reader can
   see, never an implicit hole — the FULL set, because a plant of a
   `pairingRequired` type with no fact has no claim and is refused by the
   kernel's seal even when the envelope admits it (#560's review round 1,
   finding 11); and the sweep's standalone
   `decision.approved` plants that exist to probe the OUTBOX —
   `outbox.test.ts`'s relay, rollback and seal cases, which carry no
   approval revision — move to a family the catalog does not mark
   `pairingRequired` (`decision.published`, an announcement with no
   transition fact), keeping
   every outbox assertion and gaining nothing to bypass, while a probe that
   genuinely needs an approval event builds its fact bundle through the
   service; a tripwire enumerates every raw `INSERT INTO "DomainEvent"` in
   `test/` and `scripts/` and asserts each uses the helper or a named
   bypass. 4d-i SEEDS the catalog with the CURRENT compiled catalog
   as literal SQL (a tripwire asserts the migration's rows equal
   `canonicalCatalog()` at the migration's coverage version, so the file
   cannot drift from the code it mirrors); 4d-ii's catalog-data migration
   ADDS the widened catalog's rows at the NEW coverage version BESIDE the old
   ones (a still-serving pre-4d-ii process emits intents at the old version
   through the drain and must not be refused — the dark-migration rule);
   4d-iii RETIRES the old version's rows by a durable TOMBSTONE, never a
   delete (#556's review round 2, finding 3: a deletion is undone by the next
   mature-database `ALWAYS_EXECUTE` replay of 4d-i, whose permanent seed
   would re-create the old rows, and between that replay and 4d-iii's a
   hand-run event carrying the retired intent would pass the envelope seal
   and outlive the second deletion) — `ExternalEffectCatalog.retiredAt`,
   nullable, whose NULL → timestamp stamp under the gate is the ONE admitted
   UPDATE and is frozen once set; the envelope seal admits only an intent
   whose row has `retiredAt IS NULL`, so an intent at the retired version is
   refused from then on; EVERY catalog seed (4d-i's, 4d-ii's) is `INSERT …
   ON CONFLICT (coverageVersion, effectKey) DO NOTHING`, so a replay over a
   retired row changes nothing and never reopens the coverage — the
   tombstone outlives every replay exactly as `RolloutRetirement` does; and
   `outbox:seal-external`'s singleton `coverageVersion` must equal the newest
   UNRETIRED persisted version, an equality the outbox-mode bootstrap asserts
   beside its compiled-catalog check (P37's arm: after 4d-iii, an intent at
   the retired version refused; a 4d-i replay over the mature database
   leaving every retired row retired and the same intent still refused). A
   hand-run writer copies its intent from the catalog row or is refused —
   the envelope is verified against kernel truth, never manufactured.

   **The audit row is as immutable as the fact** (#554's review round 1,
   finding 5): `DecisionEvent` carries the delivered statement-level
   `DecisionEvent_t4a_no_truncate` and the delivered
   `DecisionEvent_no_withdrawn_approval` guard, and no seal against UPDATE or
   DELETE — a direct writer could delete or rewrite a `countersigned`,
   `stranded_resolved` or `forwarded` row after its transition committed.
   4d-i installs `DecisionEvent_t4d_append_only` as a BEFORE **INSERT OR**
   UPDATE OR DELETE trigger. Its UPDATE and DELETE arms refuse every such write
   on the register (no service path mutates a `DecisionEvent` — the writer sweep
   pins it). **Its 4d-i INSERT arm exists for one reason and does one thing: it
   is the PAIRING CLAIMANT for the re-notification branch** (#572's review round
   14, finding 3). When `decisions.effects` handles a 0 → 1 architect crossing it
   inserts a `countersign_renotified` audit row as the claimed primary fact of a
   pairing-required `decision.awaiting_countersign` event — that designation is
   round 4's finding 5 and round 9's finding 1, and it is the ONE branch whose
   only fact is an audit row. A claim is made by a trigger on the claimant, and
   there was no INSERT trigger on this table at all, so nothing could call
   `platform_claim_event_pairing` and EVERY legitimate re-notification would
   have aborted at commit as unclaimed. The arm is installed in **4d-i** and not
   later, by round 11's own rule: the claiming seal belongs to the unit that
   makes the event pairing-required, never a subsequent one. Beside it — on a SEPARATE, DEFERRED trigger, never this immediate one —
   4d-i creates `DecisionEvent_t4d_correspondence` with the WEAK CONVERSE for all
   eight listed audit kinds: a same-transaction `DomainEvent` naming the row's
   decision whose type is the one the row's TRANSITION emits — derived from the
   audit kind AND the decision's committed status, never from the kind alone
   (round 20 finding 2; round 21 findings 1 and 3; round 23 finding 1) — which
   the running release satisfies and a standalone plant cannot. It
   claims for
   `countersign_renotified` and nothing else CLAIMS — no other audit kind is a
   claimant, and a second claim for one event is refused by the register's
   per-event UNIQUE.

   **"Does nothing else" is about the CLAIM, not about verification, and the
   sentence is corrected here because it read as though nothing verifies**
   (#572's review round 19, finding 1 — declined on its stated mechanism, folded
   on its wording). Everything a re-notification demand must prove is already
   required, by the ENTRY SEAL'S CONVERSE on `decision.awaiting_countersign`
   above, which is DEFERRED and therefore judges the finished transaction: the
   payload's `renotified`, `crossingEventId` and `transitionId`;
   `platform_event` proving the crossing is a committed
   `membership.standing_changed` of this project naming that transition at an
   EARLIER position and being the 0 → 1 ACTIVATION (`activeCount = 1`, `to` an
   active architect, so a 1 → 2 cannot be cited); `platform_latest_event`
   proving the decision's latest demand sits at or before that crossing; exactly
   one same-transaction audit row naming the same crossing and transition; the
   partial UNIQUE index making a second demand per (decision, crossing)
   unrepresentable; and the push-shape check with its sorted, distinct audience.
   A forged demand meets none of those, and that converse fires at commit
   whether or not a claim was made — so the claimant is not the verifier for
   this branch and was never asked to be. The claim arm exists because round
   11's rule puts the claiming seal in the unit that makes the event
   pairing-required; the verification lives where the predicates can be read.

   That the CONVERSE below arrives only in 4d-iii is deliberate and is not the
   same arm: a claim must exist from the moment pairing does, while a converse
   that demands a fact and a transition cannot be installed until the previous
   release has drained. P29b's re-notification arms gain the claim assertion —
   the crossing's `countersign_renotified` row claiming its event and
   COMMITTING, the same row inserted with the claim trigger absent refused as
   unclaimed, and a second claimant for that event refused on the UNIQUE.

   **And 4d-iii gives the register an INSERT converse — as a SEPARATE DEFERRED
   constraint trigger, `DecisionEvent_t4d_correspondence`, never as another arm
   of the immediate one** (#572's review round 15, finding 2). Round 13 wrote
   the converse into the immediate trigger, and the delivered writers insert the
   audit row BEFORE they emit: `decisions.service.ts:534` (approve/reapprove),
   `:863` (`requestChange`) and `:924` (`withdrawChange`) each call
   `decisionEvent.create` and reach `emitEvent` several statements later, in the
   same transaction. An IMMEDIATE BEFORE INSERT arm fires at the `create` and
   looks for a `DomainEvent` that this transaction has not written yet — so it
   would reject EVERY approval, change request and withdrawal after 4d-iii,
   which is a production outage installed by a seal meant to catch a forger.
   Deferred to commit, the arm sees the finished transaction and judges what
   the writer actually built. This plan already made exactly this split once —
   round 4's finding 1 divided `Notification_t4d_binding` by trigger timing for
   the notice-before-event ordering — and the same reasoning applies here for
   the same reason. **The immediate trigger keeps what must be immediate**: the
   UPDATE and DELETE refusals, and the 4d-i INSERT arm's pairing claim, which
   cannot be deferred because a claim is made AT the insert. **The seed learns
   ONE new name**: its `DecisionEvent` plants now disable
   `DecisionEvent_t4d_correspondence` beside `DecisionEvent_t4d_append_only` in
   the same `DO $$ … pg_trigger … DISABLE TRIGGER` block — round 13 said the
   reset "learns no new name", and with the split that is no longer true; the
   honest statement is one name, in the file that already lists the other.

   The converse exists because an
   append-only register that anyone may append to is not evidence (#572's
   review round 13, finding 2). An UPDATE-and-DELETE seal protects a row that
   exists and says nothing about a row that should not. A database-role writer
   inserting an `approved` or `reapproved` row AFTER the legitimate approval
   transaction committed meets every seal this plan installs: the fact-side
   correspondence already ran inside that committed transaction and cannot
   reach a later statement, and the delivered
   `DecisionEvent_no_withdrawn_approval` guard admits the insert while the decision is approved. The row is
   then permanent — by this very seal — and it is not inert: `approve` allocates
   the next revision's version from `Math.max(registerHead, priorApprovals) + 1`
   where `priorApprovals` COUNTS `DecisionEvent` rows of type `approved` and
   `reapproved` (`decisions.service.ts`), so a fabricated audit row inflates the
   next genuine approval's version and corrupts the revision sequence as well as
   the history. The trailing arm therefore requires, for each of the audit kinds
   this plan's correspondence names (`approved`, `reapproved`, `countersigned`,
   `stranded_resolved`, `forwarded`, `change_requested`, `change_withdrawn`
   **and `countersign_renotified`** — EIGHT), its matching FACT, its transition
   and its `DomainEvent` in the SAME transaction — the converse of the direction
   §A.3 already states, which asks the fact for its audit row and never asked
   the audit row for its fact.

   **The eighth is round 19's real residue** — not the defect that finding
   described, but one its trace exposed. The entry seal's converse fires on the
   DEMAND, so it judges every forged demand and no forged row that arrives
   WITHOUT one. A lone `countersign_renotified` audit row, planted with no
   `decision.awaiting_countersign` beside it, records a re-notification that
   never happened into an append-only register P29b reads as evidence of the
   crossing: no demand, so nothing for the event-side converse to fire on, and
   the partial UNIQUE index forbids only a SECOND row per (decision, crossing),
   never a first. Requiring its demand, its crossing and its transition in the
   same transaction closes it, for exactly the reason the other seven are
   here.

   **The FULL converse is trailing; a WEAKER one is not, and 4d-i carries it**
   (#572's review round 20, finding 2). Round 13 stated the 4d-i → 4d-iii window
   and called the drain its closure, which is wrong in the half that matters: the
   drain stops FUTURE forgeries, and a row planted during the window is made
   PERMANENT by this trigger's own UPDATE/DELETE arms and is counted forever by
   `priorApprovals`. Installing a deferred trigger at 4d-iii validates nothing
   that already exists. So the window has to close at 4d-i, and it can, because
   the reason given for deferring the whole converse applies only to PART of it:
   the previous release lacks the 4d ENVELOPE PAIR and the 4d FACTS, but it does
   emit its event in the same transaction as its audit row, every time —
   `decisions.service.ts:534` then `:546` (approve and reapprove), `:863` then
   `:865` (`change_requested`), `:924` then `:926` (`change_withdrawn`).

   **So 4d-i CREATES `DecisionEvent_t4d_correspondence` — the DEFERRED
   constraint trigger — carrying the WEAK arm, and 4d-iii replaces its body with
   the full one** (#572's review round 21, finding 1). Round 20 put this arm on
   `DecisionEvent_t4d_append_only`, which is IMMEDIATE, and cited those very line
   numbers as the evidence that the running release satisfies it. They prove the
   opposite for an immediate trigger: at the audit row's INSERT the event does
   not exist yet, so every ordinary approval, change request and withdrawal would
   be refused from 4d-i — the identical outage round 15's finding 2 diagnosed for
   the FULL converse, re-committed four rounds later by moving an arm without
   re-deriving its timing. The immediate trigger keeps only what must be
   immediate: the UPDATE and DELETE refusals, and the pairing claim.

   **And the weak arm is KIND-MATCHED, not merely event-present** (#572's review
   round 21, finding 3). "Some same-transaction event naming this decision" is
   satisfied by ANY event on that decision, so a writer could append an `approved`
   audit row beside a catalog-valid `decision.published` — an event that owes no
   approval fact — and the row would commit, become immutable, and inflate
   `priorApprovals` and every later revision number exactly as the standalone
   plant would.

   **The permitted event type is derived from the TRANSITION, not from the audit
   kind alone** (#572's review round 23, finding 1, correcting round 21's own
   fix). Round 21 wrote a kind → type function, and the correspondence table
   below refutes it in four of its eight entries: a provisional approve writes an
   `approved`/`reapproved` audit row beside `decision.awaiting_countersign` and
   NO `decision.approved`; a countersign writes `countersigned` beside
   `decision.approved`/`decision.reapproved`; `decision.countersigned` is not a
   type at all, in the delivered catalog (`packages/shared/src/platform/events.ts`
   carries exactly four decision types) or in 4d's additions; and
   `stranded_resolved` has no "own event" — it accompanies
   `decision.approved`/`reapproved` on the `completed` outcome and
   `decision.change_requested` on the `returned` one. A kind → type FUNCTION
   cannot express any of that, because the same kind appears under two event
   types and the same event type under three kinds. Round 21 fixed the looseness
   and installed a map that would have REFUSED every chain transition at commit —
   the outage it had just diagnosed, one axis over.

   What the deferred arm can read at commit is the audit row, the decision's
   COMMITTED `status`, and the transaction's events; a 4d FACT it cannot read,
   which is the whole reason this arm is weak. The pair (kind, committed status)
   is enough, and it is read straight off the correspondence table:

   | audit `DecisionEvent.type` | `Decision.status` at commit | required same-transaction `DomainEvent.eventType` |
   |---|---|---|
   | `approved` | `awaiting_countersign` | `decision.awaiting_countersign` |
   | `approved` | `approved` | `decision.approved` |
   | `reapproved` | `awaiting_countersign` | `decision.awaiting_countersign` |
   | `reapproved` | `approved` | `decision.reapproved` |
   | `countersigned` | `approved` | `decision.approved` or `decision.reapproved` |
   | `stranded_resolved` | `approved` | `decision.approved` or `decision.reapproved` |
   | `stranded_resolved` | `change` | `decision.change_requested` |
   | `change_requested` | `change` | `decision.change_requested` |
   | `change_withdrawn` | `approved` | `decision.change_withdrawn` |
   | `forwarded` | any | `decision.forwarded` |
   | `countersign_renotified` | `awaiting_countersign` | `decision.awaiting_countersign` |

   Any (kind, status) pair not in this table is REFUSED — the table is closed,
   not a set of hints.

   **That table is the FULL correspondence, installed at 4d-iii. The WEAK body
   4d-i installs is its restriction to the four kinds the previous release
   writes, and it REFUSES the other four outright** (#572's review round 24,
   finding 1, correcting round 23's own fix). Round 23 gave the weak arm the
   whole table, and through the 4d-i → 4d-iii window that admits a
   `countersigned` row on an ordinary direct approve: the committed status is
   `approved`, the same-transaction event is `decision.approved`, the pair is in
   the table, and the revision — not the audit row — is the event's pairing
   claimant, so the extra row commits and becomes immutable history that
   4d-iii's converse never revisits, because it validates INSERTS and not rows
   already written. The premise that makes the fix simple is the reservation
   doors' own: through that window `Decision_t4d_awaiting_reserved` and
   `Decision_t4d_architect_reserved` stand and 4d-ii-a is a DARK server, so NO
   chain transition can legitimately occur — `countersigned`, `stranded_resolved`,
   `forwarded` and `countersign_renotified` are unreachable, and a row of any of
   those kinds in that window is by construction a forgery. So the weak body is
   the four rows `approved`/`approved`, `reapproved`/`approved`,
   `change_requested`/`change` and `change_withdrawn`/`approved` — the pairs
   `decisions.service.ts` writes today — and every other audit kind is refused
   until 4d-iii replaces the body with the closed table above. The chain rows of
   `approved` and `reapproved` (status `awaiting_countersign`) belong to that
   later body for the same reason: the status they name cannot exist while the
   reservation stands. Two entries are worth stating because they are the ones a
   function would get wrong: the `returned` resolution writes BOTH
   `stranded_resolved` and `change_requested` in one transaction with ONE
   `decision.change_requested`, and both rows are satisfied by it; `forwarded` is
   the one kind whose status is unconstrained, because the holder mutation leaves
   the status where it was.

   **The window is checked against the delivered writers, not assumed.** The
   previous release reaches exactly four of these rows — approve from `pending`
   (`approved` / `approved` / `decision.approved`), reapprove from `change`
   (`reapproved` / `approved` / `decision.reapproved`), `requestChange`
   (`change_requested` / `change` / `decision.change_requested`) and
   `withdrawChange`, whose `updateMany` sets `status: 'approved'`
   (`decisions.service.ts:911-913`) beside its `change_withdrawn` row and
   `decision.change_withdrawn` event — so every ordinary transaction of the
   running release commits under this arm from 4d-i, and every chain transition
   commits under it from 4d-ii-a, when the server that writes them ships. 4d-iii
   then adds the FACT and its TRANSITION to the same trigger; what moves earlier
   is only the pair the previous release already writes. What this cannot reach is the cohort written BEFORE 4d-i:
   those rows predate every seal, they are the legacy class this plan already
   treats as unprovable, and no trigger installed later can validate them — said
   here rather than left as an implied claim of completeness. **The sanctioned
   resets learn the widened trigger at their INSERT sites too**: `prisma/seed.ts`
   plants `DecisionEvent` rows for a pre-4d world that carries no events, so its
   plants join the same `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …) …
   DISABLE TRIGGER` protocol under this seal's name — the name both files
   already disable before deleting, so no new name is learned, only a second
   site for one they know. P31 gains the fabricated standalone insert of each
   listed kind, **REFUSED from 4d-i — not from 4d-iii** (#572's review round 26,
   finding 2): this sentence predated the weak converse and said "admitted
   before it", which the round-23 and round-24 corrections made false. From
   4d-i the four legacy kinds require their matching event and the four 4d-only
   kinds are refused outright, so a standalone audit row of ANY listed kind is
   refused the moment the seal exists, with the decision's revision sequence
   unmoved; the only rows outside validation are the pre-4d-i legacy cohort,
   which no trigger installed later can reach. Leaving the old expectation
   standing would have certified an implementation that keeps the
   audit-forgery window those two rounds closed, or produced a test suite that
   contradicts its own contract — the superseded-sentence-beside-its-replacement
   defect, on the PROOF site of a fix whose contract and inventory I had already
   corrected. And the seed's plants commit inside their named bypass with the
   seal enabled afterwards. **And it gains the table above,
   driven row by row from 4d-i** (round 23, finding 1): every (kind, status) pair
   COMMITTING with its named event — the provisional approve's
   `approved`/`reapproved` beside `decision.awaiting_countersign`, the
   countersign's `countersigned` beside `decision.approved`/`reapproved`, the
   `completed` and `returned` resolutions' `stranded_resolved` beside their two
   different types, the `returned` outcome's two audit rows satisfied by its ONE
   event, and `forwarded` under each status the holder mutation leaves — each RED
   against round 21's kind → type map, which refuses the first four outright and
   demands a `decision.countersigned` that no catalog defines, **and the whole
   table driven at 4d-i RED against round 23's unrestricted pair table, which
   admits a `countersigned` row on an ordinary direct approve through the
   window** (round 24, finding 1); beside them the
   PAIR-MISMATCH arms, an `approved` row beside `decision.published` and an
   `approved` row beside `decision.approved` on a decision committed
   `awaiting_countersign`, both REFUSED, which is the looseness round 21 was
   right to close.

   The register is its legacy `actor` label rows
   included. **The sanctioned resets learn the seal by name** (#554's review
   round 2, finding 3): `apps/api/prisma/seed.ts` and
   `test/integration/fixtures.ts::wipeDecisionEvents` disable
   `DecisionEvent_no_withdrawn_approval` before deleting these rows and
   re-enable it after; `DecisionEvent_t4d_append_only` joins both, in the
   same transactional disable → delete → enable protocol and the same `DO $$
   … IF EXISTS (SELECT 1 FROM pg_trigger …) … DISABLE TRIGGER` shape the seed
   uses (so a pre-4d-i database resets unchanged), with a probe that the
   seed's reset and the fixture's wipe both succeed on the 4d-i schema with
   the seal installed and enabled afterwards. **And EVERY `DecisionEvent` UPDATE and DELETE site in the repository is
   enumerated, by category, and lands in one of three admitted shapes**
   (#555's review round 1, finding 4, and its review round 2, finding 3 —
   round 1 listed the suites that disable the approval guard by hand and
   missed the cleanups that delete with no bypass at all, which the
   unconditional seal aborts; a tripwire that greps for `DISABLE TRIGGER`
   cannot see a site that never disabled anything): (a) the HAND-DISABLED
   sites — `change-control.test.ts`, `phase1-baseline.test.ts`,
   `phase6-t4b-approval-attribution.test.ts` and the four reset transactions
   of `phase6-t4a-withdraw.test.ts` each disable
   `DecisionEvent_no_withdrawn_approval` by name before
   `decisionEvent.deleteMany` — rewritten to call `wipeDecisionEvents`; (b)
   the UNGUARDED deletions — `phase6-t4b-decider.test.ts` at its three
   per-test discards of an unpublished draft, `phase6-t4a-withdraw.test.ts`
   at its two child-clearing deletes before a hostile probe, and
   `decision-option-kinds.test.ts`'s raw `DELETE FROM "DecisionEvent"` under
   a `sealed(...)` wrapper naming only the approval guard — each routed
   through `wipeDecisionEvents` (the raw-SQL site through the same helper,
   its wrapper retired for this table); (c) the WHOLE-TABLE reset
   transactions — `phase6-t4b-decider.test.ts` and
   `phase6-t4c-ii-consultation.test.ts` run `ALTER TABLE "DecisionEvent"
   DISABLE TRIGGER USER` inside a `$transaction([...])` that re-enables —
   which pass the new seal and stay as they are, a NAMED whole-table bypass
   in a reset; (d) the three PRECISION arms of `phase6-t4a-withdraw.test.ts`
   that assert a BENIGN UPDATE or DELETE of a non-approval row SUCCEEDS
   (round 10's `actor` rewrite, round 12's `published` delete, round 13's
   `decisionId` re-point) — refused by the append-only seal from 4d-i, so
   4d-i rewrites them to assert the refusal comes from
   `DecisionEvent_t4d_append_only` by its message while the approval
   evidence rows are still refused by `DecisionEvent_no_withdrawn_approval`'s
   message (BEFORE triggers fire in name order, the delivered guard before
   the new seal, so the delivered guard's precision stays observable); (e)
   INSERT sites (`upgrade-proof.sh`'s legacy plants, the
   `phase6-t4b-approval-attribution` and `decision-option-kinds` raw
   inserts) untouched — INSERT is what the register admits. The TRIPWIRE
   enumerates STATEMENTS, not bypasses: every Prisma `decisionEvent.delete`,
   `deleteMany`, `update`, `updateMany` or `upsert` and every raw `DELETE
   FROM "DecisionEvent"` or `UPDATE "DecisionEvent"` in `test/` and
   `scripts/` must be inside `fixtures.ts::wipeDecisionEvents`, or inside a
   `$transaction([...])` whose earlier element disables the table's
   triggers (`DISABLE TRIGGER USER` on `"DecisionEvent"`, or both seals by
   name) and whose later element re-enables them, or a hostile arm asserted
   `rejects`; any other site fails the tripwire, and the round-1 grep for
   `DISABLE TRIGGER "DecisionEvent_` outside the helper stays beside it, so a
   later suite can reintroduce neither a private bypass nor an unguarded
   deletion. **And the row's WHOLE
   attribution corresponds** (#554's review round 2, finding 6): beside
   `type`, decision, `actorId` and `actorRole`, the check requires
   `actorName` AND the legacy `actor` label to equal the fact's frozen name,
   and every payload field the correspondence table names to equal the
   frozen fact's field — `forwarded`: `fromDesignation`, `toDesignation`,
   `reason`; `countersigned`: the `revisionId`; `stranded_resolved`:
   `outcome`, `reason`; `change_requested`: `reason`, `costImpact`,
   `timeImpactDays` from the request row; `approved`/`reapproved`: the exact
   finalized `revisionId` (from 4d-ii; the drain fallback above) and the
   revision's option label and material (through its `optionKey`) and
   `onBehalfOf` — the same fields bound on the `DomainEvent` payload where the
   event carries them. A payload field the table does not name is content
   (the boundary above).

   **The feed row carries structured semantics the seal can judge, and the
   readers render from them** (#554's review round 1, finding 7): a
   `Notification` is a DERIVED communication artifact (the schema's own
   words), and a seal cannot judge free text. `Notification.eventId` and
   `Notification.kind` are the two columns this obligation needs — `eventId`
   nullable, bound by a SAME-PROJECT composite FK `(projectId, eventId)` to
   `DomainEvent(projectId, eventId)` — `DEFERRABLE INITIALLY DEFERRED`,
   because the delivered writers (`approve` among them) create the notice
   BEFORE `emitEvent` allocates the event, and 4d-ii lets each writer
   PREALLOCATE the id — `EmitInput` gains an optional `eventId`, a
   caller-minted UUID that `emitEvent` passes into `domainEvent.create`
   instead of letting PostgreSQL default it (absent, the kernel mints as
   today) — so the notice is stamped with the id the event will carry
   rather than reordering every writer (#563's review round 1, finding 2:
   without the field the writers could not populate `Notification.eventId`
   before the event existed, and after the trailing seal those transitions
   could not commit);
   the FK and the binding trigger both judge at commit (#562's review round
   1, finding 4: an immediate FK would have rejected every affected
   publish, approval and withdrawal transaction) — a two-column candidate
   key 4d-i adds
   beside the delivered `(eventId, projectId, streamPosition)` key
   `OutboxDelivery` binds to (a feed row holds no position, so it names the
   two-column key) — #555's review round 2, finding 4: an FK on `eventId`
   alone let a direct writer bind project A's feed row and visible decision
   to project B's event, copy its `eventType` into `kind`, and have A's
   renderer serve B's event-derived content, the FK, the trailing seal and
   the binding freeze all accepting it; with the composite key a
   cross-project binding is unrepresentable at insert, and
   `Notification_t4d_binding` below freezes `projectId` and `eventId` so it
   cannot be reached by update either; and the key proves a shared PROJECT,
   not a shared DECISION, so a SECOND platform-owned trigger —
   **The kinded row's LEGACY CACHE is frozen with it** (#572's review round 25,
   finding 3). 4d-ii stamps `eventId` and `kind` onto the existing approval and
   consultation writers while a 4c API is still serving — the drain is exactly
   the interval where both releases run — and that older replica has no
   structured renderer, so it serves the stored `text` and `color` verbatim.
   Leaving those two columns writable on a kinded row lets a database-role
   writer rewrite the cache AFTER commit and have the legacy replica disclose
   the forged copy for the whole drain, while every new reader, rendering from
   the event, sees nothing wrong. So `text` and `color` join `projectId`,
   `eventId`, `kind` and `decisionId` in the kinded-row freeze: on a row
   carrying `kind`, all six are immutable from the moment it is written. Rows
   with no `kind` are untouched — the legacy shape stays editable exactly as
   today — and the freeze is therefore reachable only by rows 4d itself
   creates. P32 gains the post-commit `text` rewrite and the `color` rewrite on
   a kinded row, both REFUSED, and the same two on a kind-less row COMMITTING.

   `Notification_t4d_binding_bound`, DEFERRABLE INITIALLY DEFERRED on INSERT,
   checked at COMMIT — reads the platform's own two tables and requires that a
   kinded row bound to an event whose `entityType = 'Decision'` CARRY a
   `decisionId`, and that it equal that event's `entityId`; identity columns
   compared, with no decision semantics in the platform.

   **The predicate is on the OPERATION, not on the column's presence** (#572's
   review round 24, finding 4). An earlier wording required this only of "a
   kinded row CARRYING `decisionId`", which is a condition a forger simply
   declines to meet: the surrounding constraints admit `eventId` and `kind`
   non-NULL beside `decisionId = NULL`, so a database-role writer mints a kinded
   notice for a Decision event, passes the project FK, the kind equality, the
   uniqueness and the late-insert converse, and lands a row the readers cannot
   run `decisionVisibleToViewer` against — the delivered null-ID fallback
   filters pending-TEXT notices and nothing else, so a `forwarded` notice
   reaches a viewer who may not see the decision it describes. That is round
   12's own rule — *enumerate the OPERATIONS a seal must cover, not the columns
   a row happens to carry* — unfixed on the very seal this plan added it for,
   and it is a DISCLOSURE, not merely an integrity gap, which is why it moves
   with the seal rather than into a later stage. P32's arms gain the kinded
   Decision-event notice inserted with a NULL `decisionId`, REFUSED at commit,
   and with a `decisionId` naming a DIFFERENT decision than the event's
   `entityId`, also refused — RED against the carrying-row-only predicate,
   which admits the first.

   **Two triggers, because one cannot do both jobs** (#572's review round 4,
   finding 1). An earlier draft gave this arm to `Notification_t4d_binding`,
   the `BEFORE UPDATE OR DELETE` freeze below. That object is not
   implementable: the arm must see a `DomainEvent` the same transaction
   inserts LATER — the delivered writers mint the notice before the event —
   so it has to run at commit, and PostgreSQL has no trigger that is both an
   immediate `BEFORE` trigger and a deferred constraint trigger. Whichever
   half won, the other was lost: an immediate `BEFORE INSERT` rejects every
   notice-before-event writer, and a deferred constraint trigger cannot
   perform a `BEFORE`-time freeze. So the timings are separate NAMED objects
   with separate remits — `Notification_t4d_binding_bound` (deferred, INSERT,
   the same-decision binding) and `Notification_t4d_binding` (immediate,
   `BEFORE UPDATE OR DELETE`, the freeze) — and P31 asserts each independently
   against a writer that exercises only its half (#558's review round 1, finding 3: with
   decisions A and B in one project a direct writer could bind A's notice to
   B's otherwise-unused event, copy its type into `kind`, and have the
   readers authorize on A while rendering B's content) — partially UNIQUE on `eventId` where
   non-NULL (one feed row per event — the promised idempotency, now a
   constraint the schema can express); `kind` nullable text, CHECK-required exactly when
   `eventId` is non-NULL and equal, under the seal, to the bound event's
   `eventType` — stamped by every decisions notification writer from 4d-ii
   and by the 4d transitions from their first commit; NULL only on legacy
   rows and on rows the previous release writes during the drain; both
   REQUIRED — by a trailing 4d-iii INSERT-time seal — on every new row
   carrying a `decisionId`.

   **A kinded feed row must be AUTHORIZED IN the event's transaction, not merely
   shaped like one** (#572's review round 13, finding 3). The binding seal
   freezes `eventId`, `kind`, `decisionId` and `projectId` and refuses the row's
   DELETE, and the correspondence asks each transition for the notice it owes —
   both of which run inside the authoring transaction. A database-role writer
   inserting a kinded notice LATER, for an already-committed event that owed
   none (the `decision.change_requested` event of a `standard` request is the
   plan's own example of a no-notice branch), satisfies the required
   `eventId`/`kind`, the same-decision FK, kind equality and the partial
   uniqueness — and the transition's seal cannot object, because that
   transaction is over. The row is then UNDELETABLE by the same binding seal,
   and every reader renders a notice for a branch this table says writes none.
   So 4d-ii's kinded arm gains the converse at INSERT: a row whose `eventId` is
   non-NULL is admitted only when THAT `DomainEvent` is inserted in the SAME
   transaction — which is exactly how the delivered writer builds it, minting
   the event id, stamping the notice and emitting under the deferred FK — and
   the no-notice branches require ZERO rows for their event, judged in that same
   transaction. Kind-less rows are untouched, so the previous release's shape
   (NULL `eventId`, NULL `kind`) passes through the window unchanged and this
   arm needs no trailing installation. P31 gains the late kinded insert against
   a committed no-notice event, REFUSED, and the delivered writer's
   notice-then-emit order still COMMITTING.

   And for a row carrying `kind`, EVERY reader —
   the snapshot's feed builder, the `decisions.inbox` fold and rebuild —
   RENDERS the display text and colour from (`kind`, the bound event's
   sealed envelope and payload, the frozen fact it corresponds to — the
   revision's `approvedByName`/`approvedByRole`, the countersigner's or
   resolver's frozen pair) and never serves the stored `text`/`color`, which
   the service still writes byte-identical to today's strings as a display
   cache for the kind-less legacy path (a tripwire pins the renderer's
   kind → text mapping to those strings, so cache and derivation agree). A
   hand-run bundle can therefore commit a feed row only with the kind the
   seal binds, and whatever `text` it wrote is never displayed to any client
   — the feed agrees with the fact and the event by construction, for every
   writer. **The binding is FROZEN and the owed notice cannot be erased**
   (#554's review round 2, finding 5): `Notification_t4d_binding`, a BEFORE
   UPDATE OR DELETE trigger — the IMMEDIATE half of the split above, carrying
   no INSERT arm — refuses on any row whose `eventId` is non-NULL a
   change to `eventId`, `kind`, `decisionId` or `projectId` (a NULLing
   included — the legacy cache path can never be re-entered) and refuses its
   DELETE; `text`/`color` stay writable as the display cache no reader
   serves for a kinded row. The delivered 4a withdraw retires a withdrawn
   decision's now-false pending notices by `deleteMany` on `decisionId`;
   from 4d-ii that retirement deletes kind-less rows ONLY (`kind IS NULL` —
   the legacy rows it was written for), and a kinded notice of a withdrawn
   decision — a forwarded pending decision the PMC then withdraws — is kept
   as history: hidden by the visibility rule below from every viewer the
   decision is hidden from, AND, for the viewer who may still see a
   withdrawn decision (the PMC), SUPPRESSED by kind where it would ask for
   an act the withdrawal cancelled (#557's review round 1, finding 5: the
   visibility filter alone would show the PMC "awaiting approval" and the
   forwarding notice beside the withdrawal notice). The kinded feed readers
   — the live snapshot, the `decisions.inbox` fold and its rebuild — omit
   every row whose kind is in the named ACTIONABLE set
   (`decision.published`, `decision.forwarded`,
   `decision.awaiting_countersign`, `decision.change_requested`) when the
   bound decision's status is `withdrawn`, and render the informational
   kinds (`decision.approved`, `decision.reapproved`,
   `decision.consultation_*`, `decision.withdrawn`) as they stand; the set
   is a constant under the renderer tripwire, the rows and their events
   remain as evidence (the binding seal forbids their deletion), and P31's
   arm asserts the PMC's feed after a forwarded pending decision is
   withdrawn shows the withdrawal notice and neither the published nor the
   forwarding notice, with both rows and events still present. **And a kinded row is served only to a viewer who may see its
   decision** (#554's review round 2, finding 7): the delivered
   `SnapshotService` feed filter recognizes the pending and withdrawn TEXT
   prefixes (`isPendingDecisionNotice`, `isWithdrawnDecisionNotice`), which a
   kinded `decision.forwarded` notice for a still-`pending` decision would
   pass straight through to a contractor the decision is hidden from; so the
   kinded feed path — the live snapshot, the `decisions.inbox` fold and its
   rebuild — filters EVERY kinded row through `decisionVisibleToViewer` for
   its bound decision BEFORE rendering, judged on the decision row read in
   the SAME STATEMENT as the notice (#558's review round 1, finding 6: the
   delivered snapshot starts its decision slice and its notification query
   independently under READ COMMITTED, so a withdrawal committing between
   them returned a kinded withdrawal notice the filter authorized against
   the stale, still-visible decision; the snapshot therefore opens ONE
   REPEATABLE READ transaction and runs the OWNER-provided queries inside
   it — the platform's notification query and the decisions module's
   decision query, each the owner's own contract — so both read the same
   snapshot and visibility is judged on the decision rows of that snapshot,
   with NO cross-module join (#558's review round 2, finding 4: a single
   statement joining `Notification` to `Decision` would have been a
   synchronous foreign read), and the projection fold, being per event, has
   no second read; P31's barrier withdraws between the two reads and asserts
   the notice absent for the contractor),
   the text-prefix filters keep governing kind-less rows, and P29's
   byte-identity holds because a kind-less feed is untouched.

   The correspondence table, closed over every transition 4d seals:

   | transition | event (`DomainEvent.eventType`) | audit (`DecisionEvent.type`) | feed row | actor bound to (id, frozen role AND name, on event, audit row and fact) | CLAIMANT — the fact present on EVERY instance of this branch, and the SEAL that claims for it. The seal must be installed by the unit that makes the event pairing-required, never by a LATER one: a claimant named on a trailing 4d-iii trigger leaves every commit in the 4d-i → 4d-iii window unclaimed, and collides with the permanent seal afterwards (#572's review round 11, finding 1). Every other fact in the bundle verifies through `platform_tx_event` and does NOT claim | armed |
   |---|---|---|---|---|---|---|
   | `pending`/`change → awaiting_countersign` (the provisional approve) | `decision.awaiting_countersign` — the ONE event of this transition (payload: the provisional act; intent: the countersign demand with the architects frozen as `targetUserIds`); a `decision.approved`/`reapproved` at this transition is REFUSED (finality is the finalizer's row) | `approved` / `reapproved` (the act happened and is attributable) | the provisional notice, `kind = 'decision.awaiting_countersign'` | the head revision's `approvedById` | the PROVISIONAL `DecisionApprovalRevision` (born `finalized = false`) — and THIS is the transaction that carries the `ChangeRequest` closure on the `change` arm, verification-only beside the revision, since the `open → resolved` closure pairs with the transition that lands `awaiting_countersign` | 4d-i (no pre-4d writer can reach the state) |
   | `awaiting_countersign → approved` by countersign | `decision.approved` / `decision.reapproved` by the revision's `approvedFrom` | `countersigned` | the green approved notice | `countersignedById` | the `DecisionCountersign` row. Its bundle is the revision flip, this fact, the status transition and their effects — and NOTHING else: the open `ChangeRequest` of a `change`-cycle revision was already closed by the PROVISIONAL approve's transaction (§A.3's `open → resolved` pairing, round 4 finding 6), which is a different command and a different transaction, so naming the closure here would demand a fact this bundle cannot contain and reject every countersign following a change cycle (#572's review round 10, finding 2 — round 9's own cell) | 4d-i |
   | `awaiting_countersign → approved` by `completed` resolution | the same, by `approvedFrom` | `stranded_resolved` | the green approved notice | `resolvedById` | the `DecisionStrandedResolution` row (written on both outcomes) | 4d-i |
   | `awaiting_countersign → change` by disagreement (reject-back or forward-on) | `decision.change_requested` | `change_requested` | the change-request notice | `requestedById` | the reject-back/forward-on `ChangeRequest` (both disagreement shapes write one) | 4d-i |
   | `awaiting_countersign → change` by `returned` resolution | `decision.change_requested` | `stranded_resolved` + `change_requested` | the change-request notice | `resolvedById` = `requestedById` | the `DecisionStrandedResolution` row — NOT its paired `ChangeRequest`, which exists only on the `returned` outcome | 4d-i |
   | the holder mutation (forward, generic or forward-on) | `decision.forwarded` | `forwarded` | the forward notice | `forwardedById` | the `DecisionForward` fact | 4d-i |
   | `pending`/`change → approved` with NO chain (the direct approve) | `decision.approved` / `decision.reapproved` | `approved` / `reapproved` | the green approved notice | the head revision's `approvedById` | the `DecisionApprovalRevision` (born `finalized = true`) — written from `pending` and from `change` alike, while the `ChangeRequest` CLOSURE of the `reapproved` arm exists only when approving from `change`, so the revision claims and the closure verifies (#572's review round 9, finding 1) | event + audit row from 4d-i (the delivered `approve` writes both in-transaction, so the previous release is compatible through the drain); the feed row's `eventId` binding from 4d-iii, since the previous release writes the row without it |
   | `approved → change` by the standard `requestChange` (the delivered path, `origin = 'standard'`; the request and the transition paired in BOTH directions — #568's review round 1, finding 3) | `decision.change_requested` | `change_requested` | — (the delivered path writes none) | the receipt's actor | the `ChangeRequest` INSERT, claimed by `ChangeRequest_t4d_paired` (4d-i, permanent) | event + audit row + the `ChangeRequest` row from 4d-i (delivered, in-transaction; the envelope pair NULL and `sourceCommandId` NULL through the drain) |
   | `change → approved` by standard `withdrawChange` | `decision.change_withdrawn` | `change_withdrawn` | — (the delivered path writes none) | the receipt's actor | the `ChangeRequest` CLOSURE, claimed by **`ChangeRequest_t4d_paired`** — the PERMANENT 4d-i deferred pairing seal, not the trailing provenance trigger (#572's review round 11, finding 1). Round 9 named the 4d-iii UPDATE arm, which §D installs only in 4d-iii: `decision.change_withdrawn` is pairing-required from 4d-i, and BOTH the previous release and 4d-ii execute `withdrawChange` in the window between them, so the kernel would see no claim and reject every withdrawal at commit — and after 4d-iii the two triggers would both claim and collide on the per-event UNIQUE. The trailing provenance trigger stays VERIFICATION-ONLY on this branch | event + audit row from 4d-i (delivered, in-transaction) |
   | the architect standing flip on `Membership` | `membership.standing_changed` naming the fact — payload `transitionId`, `membershipId`, `role`, `from`, `to`, `activeCount` ALL bound to the fact and the register; paired in the CONVERSE by the kernel's generic pairing seal, the fact's own seal claiming the event (§A.2) | — (orgs; the fact is the audit) | — | the fact's `actorId` and frozen `actorRole`/`actorName`, on the event envelope | the `MembershipTransition` fact (§A.2) | 4d-i (no pre-4d writer can flip the role) |

   A `DecisionEvent` written by the service for a transition this table does
   not list (the delivered `issued`, `drafted`, `draft_updated`,
   `change_withdrawn` on other paths) is untouched; the seal judges only the
   transitions it admits.

   **Every LIVE previous-release decision writer is preserved through the
   4d-i → 4d-ii drain, each with its explicit branch** (#567's review round
   1, finding 2: the approve had one, the other four did not). A 4c instance
   still serving under the 4d-i schema can run exactly five sealed writers;
   the table states what each writes in its own transaction, what the 4d-i
   seals demand, and why the two agree — no branch is implied:

   | 4c writer (delivered) | what its transaction writes | what the 4d-i seals demand of it | why it commits |
   |---|---|---|---|
   | `approve` / re-approve with no chain | the revision (`approvedByRole`/`approvedByName` NULL, `finalized` born `true` under the kept default, no `revisionId` in the payload), `pending`/`change → approved`, the `decision.approved`/`reapproved` event with the delivered broadcast push and a NULL envelope pair, the `approved`/`reapproved` audit row, the feed row without `eventId` | the event and the audit row, attribution by `actorId` alone (the pair NULL), the converse's same-transaction revision insert as the finalizer, the broadcast push shape, no `eventId` binding on the feed row until 4d-iii | every demanded part is written; nothing demanded is absent (P42's arm) |
   | `requestChange` (`origin = 'standard'`) | the `approved → change` CAS, the open `ChangeRequest` (`sourceCommandId` NULL, the frozen pair NULL), the `change_requested` audit row, the `decision.change_requested` event with `dispatch: {}` and a NULL envelope pair — NO notice, all in one transaction under the readiness lock | the event and the audit row, attribution by `actorId` alone, the `ChangeRequest` row claiming the event, the request and the `approved → change` transition paired in BOTH directions, NO feed row for the standard origin, NO push (the catalog row's `requiresPush` is false, matching the delivered emitter), `sourceCommandId` admissible NULL until 4d-iii | the notice and the receipt are demanded only of the `countersign_rejection` origin and only after 4d-iii respectively |
   | `withdrawChange` | the open request written to `withdrawn`, `change → approved`, the `change_withdrawn` audit row, the `decision.change_withdrawn` event with `dispatch: {}` and a NULL envelope pair — all under the readiness lock | the closure ↔ restoration bundle (all three parts), the event and the audit row, attribution by `actorId` alone, no feed row | the delivered path already writes the whole bundle in one transaction |
   | `requestConsultation` | the `DecisionConsultation` row (the frozen requester pair NULL, `sourceCommandId` set — the 4c receipt), the `decision.consultation_requested` event targeted at the consultee (`targetUserId`) | the same-transaction event naming the consultation with its push targeted at the frozen `consulteeUserId` (the delivered shape), the requester arm on the delivered `phase6_user_decision_authority` through the window (the window rule of §A.2), the frozen pair admissible NULL until 4d-iii | the delivered emitter targets exactly the consultee; the pair is demanded only by the trailing seal |
   | `respondToConsultation` | the response row (the frozen responder pair NULL), the `decision.consultation_responded` event targeted at the requester with `roles: ['pmc']` | the event naming the consultation, targeted at the fact's `requestedById` with `roles` bound to the frozen requester role — `['pmc']` where that role is NULL (the delivered ceiling, P38's legacy-NULL arm), the responder pair admissible NULL until 4d-iii | the delivered shape IS the NULL-role shape the seal admits |

   `create`, `updateDraft`, `publish` and every other delivered command emit
   types the correspondence does not list and are untouched. P42 drives all
   five shapes, exactly as the 4c release writes them, through the 4d-i
   seals and asserts each COMMITS, then the same shapes after 4d-iii and
   asserts each is refused only where a trailing seal requires what the
   shape lacks — RED against a NULL rule that admits the approve alone.

The closed enumeration over every fact these units add:

| fact | pairing (2) | actor standing (3) | subject eligibility (4) | provenance (6) | effect (7) | probes |
|---|---|---|---|---|---|---|
| `Decision` holder columns (4b) | the forward door, from 4d | named decider membership ACTIVE at create/holder-write | the kind⟺status CHECKs; the delivered orphan guard, open set widened to `awaiting_countersign` | — (the decision row's own commands are ledgered) | `decision.forwarded` on the holder mutation | P17/P18/P34/P39 |
| `DecisionConsultation` (4c) | — | `requestedById` ACTIVE pmc **+ architect (4d — the seal's arm re-pointed by 4d-iii after the fenced re-projection, the window rule of §A.2)**; consultee ACTIVE at insert; frozen requester role + name judged (4d) | open (`pending`/`change` **+ `awaiting_countersign` (4d)**) AND published | delivered | `decision.consultation_requested` naming the consultation — SEALED in 4d-i in both directions (#561's review round 1, finding 3) | P25/P27/P37 |
| `DecisionConsultationResponse` (4c) | — (UNIQUE per consultation) | responder is the named consultee; frozen responder role + name judged (4d) | the same predicate re-judged at response, cycle-frozen | delivered | `decision.consultation_responded` naming the consultation — SEALED in 4d-i in both directions (#561's review round 1, finding 3) | P23/P25/P27/P37 |
| `DecisionForward` (4d) | holder mutation ⟷ row | `forwardedById` = holder-user / pmc / architect, ACTIVE; frozen role + name judged | `pending`/`change` only; `awaiting_countersign` ONLY with the same-tx `countersign_rejection` request | required | `decision.forwarded` + `forwarded` + notice | P34 |
| `DecisionCountersign` (4d) | finality flip + `awaiting → approved` ⟷ row | `countersignedById` ACTIVE architect; frozen role + name judged | `awaiting_countersign` only | required | the finalizing event + `countersigned` + the green notice | P31 |
| `DecisionStrandedResolution` (4d) | outcome BUNDLE ⟷ row | `resolvedById` pmc; frozen role + name judged; non-blank reason | `awaiting_countersign` AND no active architect | required | per outcome, the table above | P29b |
| `DecisionApprovalRevision` finality (4d) | birth value by chain presence; flip only by paired fact; one row per approval transition | carried by the pairing facts; `approvedByRole`/`approvedByName` judged when present | the approved-entry seal | delivered (4c) | the awaiting entry's and the direct approve's rows | P31/P37/P42 |
| `ChangeRequest` origin (4d) | `countersign_rejection` ⟷ the exact `awaiting_countersign → change` transition, AND with its producer's fact (P33b); `standard` ⟷ the exact `approved → change` transition, in BOTH directions (#568's review round 1, finding 3) | by ORIGIN (#572's review round 2, finding 2): `countersign_rejection` — `requestedById` ACTIVE architect under an ACTIVE chain, or the resolving pmc; `standard` — `requestedById` holds ACTIVE standing in a role of the DELIVERED `decision.change` policy set (`pmc`, `client`, `contractor`, `engineer`, `consultant` — `packages/shared/src/domain/policy.ts`; the architect is NOT in it, and 4d does not widen it), judged EXACTLY as obligation 3 judges every fact — `platform_user_holds_role(project, user, role)` over the `ProjectUserStanding` register, whose derived `pmc` row admits the membership-less org owner/admin the delivered `ProjectAccessService` authorizes with a `pmc` token (`apps/api/src/common/project-access.service.ts`) — so a `Membership` row is NOT demanded (#572's review round 3, finding 2: an active-member rule would have refused that valid request after 4d-iii). **Window disposition: the RACE-FREE authority derivation** — a `standard` request is a 4d-ii writer a window caller reaches, so through the window its `pmc` arm asks §A.2's race-free question (an `OrgUserAuthority` owner/admin row AND no membership-granted row for that user on that project) and 4d-iii re-points it onto the register with the rest (#572's review round 5, finding 3: round 4 stated the window rule as a shared property and left this row judging `pmc` through the fanned-out register, which is precisely what that rule forbids); frozen role + name judged on both | by ORIGIN: `countersign_rejection` — the awaiting subject; `standard` — the `approved` subject, published, the exact `approved → change` transition of the delivered `requestChange` | TWO provenance columns, because this row is written by TWO commands: `sourceCommandId` (the REQUEST — REQUIRED for `countersign_rejection`, admissible NULL on `'standard'` rows only until 4d-iii) and `resolvedByCommandId` (the CLOSURE — required on every CLOSURE, which is the row LEAVING `status = 'open'` and not the resolver column being set (#572's review round 12, finding 1); admissible NULL until 4d-iii). The closure column is what the `countersign_rejection` origin gets from its resolution FACT and the standard origin, having no fact, would otherwise lack (#572's review round 5, finding 5). Its writers are DERIVED from the column it qualifies — every command that writes `resolvedById`, which the delivered service says is `withdrawChange` AND `approve`'s re-approval closure (#572's review round 6, finding 1) — so the obligation-6 derivation over this table yields TEN ledgered commands. Each such writer inherits the CLOSURE SET WHOLE (#572's review round 7): the frozen `resolvedByRole`/`resolvedByName` pair, this column, and the receipt binding — the last admitted for a closure as a `resultRef` naming the closed row's `decisionId`, which is what both writers already return | `decision.change_requested` + `change_requested`, + the change-request notice for the `countersign_rejection` origin ONLY — the standard request's transition owes none (the delivered path writes none; the notice arm is keyed on the paired request's `origin`) | P29b/P33/P33b |
| `MembershipTransition` (4d, orgs) | the architect standing write ⟷ row; one flip per membership and per project per transaction | `actorId` holds team-management authority (the owner/admin arm live; the project-PMC arm live, or the captured pre-state for a self-demotion); frozen `actorRole`/`actorName` judged | — | required (`phase6_t4d_membership_transition_bound`) | `membership.standing_changed` naming the fact — `role`, `membershipId`, `from`, `to`, `transitionId`, `activeCount` and the envelope pair all equal to the fact and the register — and paired in the converse | P29b |

A future fact table added under these units inherits this contract by
default: omitting an obligation is a defect by construction, and each unit's
review packet walks this table for every fact it ships.

**AND EVERY OBLIGATION NAMES THE OPERATIONS ITS SEAL FIRES ON** (#572's review
round 8, finding 2). An obligation is not specified until something enforces it
on the operation that can violate it, and this plan spent three rounds
improving the SENTENCE describing what a closure owes while the only seal on
its table fired on INSERT — an operation a closure never performs. Rounds 5, 6
and 7 each corrected the specification a level up (a hand list, then the derived
writer set, then the derived obligation set) and none of them asked what
enforced any of it. So the walk now carries the enforcement question beside the
obligation: for each row of this table, an obligation whose seal does not cover
every operation that can breach it — INSERT, UPDATE, DELETE, TRUNCATE — is a
defect of the same kind as omitting the obligation outright. A rule with no
enforcer on the reachable operation is a comment.

**And every actor-standing arm in the column above states its WINDOW
DISPOSITION** (#572's review round 5, finding 3). §A.2 states the window rule
as a property — through the 4d-i → 4d-iii window no seal a window writer can
reach judges a user's `pmc` standing through the fanned-out register — and
adds that an arm which cannot say which of the two dispositions it takes is a
defect. Round 4 wrote that sentence and did not walk this table with it, so
the `ChangeRequest` `standard` arm went on naming the register, which is the
one thing the rule forbids. A property stated in prose is not a swept set: the
test now runs where the arms are, so each `pmc`-judging arm reads either
*keeps its delivered predicate* or *asks the race-free derivation, re-pointed
by 4d-iii*, and an arm that reads neither fails this table's own walk rather
than waiting for a reviewer. The unit writes only
decisions-owned and orgs-owned TABLES, the platform-owned register and
kernel primitives named above, and the ADDITIVE columns on foreign rows it
declares (`revisionFinalized` on the two spec tables; `Notification.eventId`
on the platform feed table — an obligation the correspondence rule imposes,
added to the platform's own model by the platform's own migration step).

### 4. The narrowing ledger — every withdrawn mechanism, the finding it answered, and the answer that stands

Nothing below is dismissed. Each row names a mechanism #552 carried, the
review finding (by the closed PR and round in which it was raised) that the
mechanism answered, and how THIS design answers the same finding — by
refusal, by a delivered rule, or by the state being unrepresentable. A
reviewer who finds a row whose answer does not hold has found a defect in
this plan, and that is the review this unit asks for.

| withdrawn from #552 | the finding it answered | how this plan answers it |
|---|---|---|
| `platform_emit_event` — the PL/pgSQL twin of `emitEvent`, canonical-pinned, the crossing event emitted by the standing trigger, every 4d transition's event emitted by its seal | #546 round 19 (a side effect bound to service code a hand-run receipt bypasses); #547 round 21 (`decision.awaiting_countersign` emitted in the service path while the seals admitted a hand-run bundle that emitted nothing); #548 round 24 (the twin's missing actor argument) | Obligation 7: the seal REQUIRES the same-transaction event with the fact's actor and refuses the transition otherwise. A hand-run bundle that emits nothing cannot commit, so no committed state ever lacks its event; the service is the one emitter and there is no second one to keep byte-identical. The membership instance requires `membership.standing_changed` naming the fact for every standing flip. |
| The seal-written `DecisionEvent` audit row | #547 round 22 (`Notification` and `DecisionEvent` rows written by service code a hand-run bundle skips) | Obligation 7 requires the same-transaction `DecisionEvent` of the transition's kind with the fact's actor and role; a bundle without it is refused. |
| `platform_write_notification` — the notification twin, the seal-written feed row, "idempotent per (event, recipient)" | #547 round 22 (as above); #551 round 29 (the feed row derived in `decisions.effects` after the response, so the approval notice stayed absent until an unrelated refresh); #552 round 32 finding 3 (the promised idempotency had no schema) | The service writes the feed row in the transition's transaction, before the response, as the delivered 4b `approve` does today; obligation 7 requires it, bound by `Notification.eventId` (staged in 4d-i, partially UNIQUE, FK to the event) — one row per event is a constraint, not a promise. |
| The count-based emitter handoff (one same-transaction approval event → the seal defers; none → it emits; two → refused) and, before it, the `RolloutRetirement`-marker-keyed arm | #549 round 26 (the no-chain direct bundle updating the row without advancing the stream); #551 round 30 (the seal emitting the no-chain approve TWICE beside a pre-4d process); #552 round 31 (the disarmed window leaving a bundle permanently un-emitted; the marker read racing its insertion); #552 round 32 finding 1 (the count admitting a forged single event) | Obligation 7 on the no-chain `pending`/`change → approved` transition: exactly one `decision.approved`/`reapproved` event with the revision's `approvedById` and exactly one `approved`/`reapproved` audit row are REQUIRED from 4d-i. The delivered `approve` writes both in-transaction, so the pre-4d process is compatible through the drain with no arming and no window; a bundle without them is refused, so nothing is ever left un-emitted; the seal never emits, so there is no second emitter to race; correspondence is judged field by field, so a forged single event fails on its actor, kind or count. |
| `DecisionCountersignNotice` — the claim-time notice register with `standingPosition`, its INSERT-time correspondence seal (`xmin = txid_current()::text::xid` against the lease), the triple uniqueness, `ProjectRoleStanding.lastCrossingPosition` | #549 round 25 (the unordered push worker sending the original demand to B before the ordered consumer handled either crossing); #550 rounds 27–28 (the notice forgeable; the notice racing the irreversible send); #551 round 29 (the handler cancelling a claim resolved against a later standing; the per-delivery uniqueness contradicting the retry rule); #552 round 32 finding 2 (the notice's position and the send's recipients disagreeing) | The countersign demand's recipients are FROZEN AT EMISSION under the readiness lock, in the immutable dispatch intent and the delivery payload; the consumer never resolves a role at claim for this family. The crossing consumer decides per decision from the kernel's stream positions (`EventStreamQuery.latestPosition` of the decision's latest `decision.awaiting_countersign` event against the crossing's position): a demand raised at or after the crossing was resolved against the current standing and is left alone; an earlier one is cancelled (unsent) and replaced. Nothing is appended at claim, so nothing at claim can disagree with the send. |
| The per-consumer `onClaim` hook inside the lease transaction and the refactor of `claim`, `claimOne` and `claimExternalRecovery` | #551 round 29 / #552 round 31 (the claim hook needing the lease's row lock and transaction for the notice) | No notice is written at claim, so no consumer logic needs the lease transaction; the delivered relay is unchanged. |
| The reserved-value repair for `Decision` rows — `decision:repair-reserved-value` with `--decider-kind`, `--withdraw` and `--revert-provisional`, the `DecisionRepairAction` evidence register, the repair bootstrap transaction | #543 round 14 / #546 round 20 (a `Decision` row stored with a new enum value in the gap); #548 round 24 (a repair routed through a client that cannot read the row); #549 rounds 25–26 (the awaiting row neither branch could clear; the repair needing schema the aborting migration had not created) | `DecisionStatus` and `DeciderKind` are PostgreSQL enum types: no `Decision` row can hold either value before the `ADD VALUE` statements, and the two TEXT-judged doors are installed in their own transaction BEFORE those statements, so the gap the audit and the repair existed for is unrepresentable at every instant. There is no `Decision` audit, no repair branch and no evidence register; the additive nullable columns the bootstrap transaction carried are ordinary statements of 4d-i's permanent portion. The `Membership.role` and `User.role` audits stay (free-text columns), with the re-role recovery, which the pre-4d client can perform because those columns are strings it reads. |
| `CommandExecution.actorRole`/`actorName` — the receipt-captured pair, its freeze arm, the nullable-through-drain rule, the trailing 4d-iii receipt seal, and the round-31 staging | #550 round 28 (the frozen role and name supplied by the fact writer, so a PMC's hand-run forward could freeze `architect`); #551 round 29 (the receipt validated by a project-wide predicate in a platform trigger reading orgs standing; the pair mandatory while pre-4d processes reserve without it); #552 round 31 (the pair absent from 4d-i's inventory; the membership-less owner/admin issued `pmc` yet recorded otherwise) | Obligation 3 judges the fact's frozen `<act>ByRole` and `<act>ByName` at the OWNING fact seal against the actor's live standing (`platform_user_holds_role`, with the owner/admin arm admitting `pmc`) and the account's display name (`platform_user_display_name`) at the act — which is what the receipt pair existed to prove, without a platform trigger performing any lookup and without a receipt column pre-4d processes cannot write. A supplied role the actor does not hold is refused at the fact. |
| `OutboxConsumerCutover` — the sealed per-project registration cutover, its one-time fill arm (`xmin` predicate), the whole-phase replay guard | #546 round 20 (a freshly registered consumer replaying every historical `project.restored` through the backfill scanner); #547 rounds 21–22 (the cutover unsealed; created in the wrong unit); #549 round 26 and #550 round 27 (the fill arm's staging and predicate) | The round-20 hazard was retired by #547 round 21, when restoration stopped re-emitting; and this plan consumes no `project.restored` at all (parking is withdrawn — next row). `decisions.effects` consumes only `membership.standing_changed`, a NEW type with no history; every historical event of every other type becomes a recorded `noop` through its `deliveryFor`, exactly as a non-invalidating event does — bounded, one-time, and probed under P38 (zero notifications, zero `countersign_renotified` rows at registration over a database holding history). |
| Archived-project PARKING — the `parked` consumer outcome, the far-future `nextAttemptAt` HOLD sentinel, `lastError = 'project_archived'`, `releaseParked`, the `project.restored` consumption, the recovery-claim `nextAttemptAt` fix, `outbox:release-parked` | #540 round 7 (archival absent from the pre-send hook); #545 round 18 (the archived-project drop never re-emitted on restore); #547 rounds 21–22 and #548 rounds 23–24 (the park's transaction, the relay overwriting it, the recovery claim reclaiming it, a row parked after its first recipient) | The pre-send hook re-checks operability for EVERY family (round 7's finding stands answered). For the drop itself this plan takes the DELIVERED 4c rule: a non-operable project drops the delivery with the recorded cancellation mark at claim or at the pre-send barrier, and restoration re-notifies nothing — the cleared behaviour of every delivered decision push (`consultation_requested`, `consultation_responded` and `decider` already drop this way, and 4c has no restore re-emit). The demand is not lost: it is the awaiting or forwarded decision itself, served to the Inbox and Decision Log on the next read after restoration; a push is a nudge, never the record (the Board's informs-never-gates ruling applied to a notification). Round 18's premise — that restoration OWES a re-push — is answered by naming the rule rather than building a second delivery lifecycle for it; the reviewer is asked to judge that as a product rule stated, not a finding dropped. |
| `MembershipTransition.standingEventId` with its one sealed NULL→id UPDATE exception, and `Membership.lastTransitionId` | #547 round 21 (the crossing event unable to name its transition fact); #547 round 22 (the association chosen after the write); #548 round 23 (the fact column-immutable while the column had to move) | The event names the fact (payload `transitionId`) and obligation 7's membership instance requires exactly that event for exactly that fact in the same transaction; the fact needs no back-pointer, so it is fully immutable with no exception, and the swap case is refused outright (one standing flip per membership and per project per transaction). |
| The `awaiting entry precedes the crossing` rule stated as "its provisional revision being newer than the crossing" | #549 round 25 / #551 round 29 (the ordering between a demand and a crossing) | Stated as a kernel stream-position comparison: the decision's latest `decision.awaiting_countersign` event against the crossing event's position, both recorded by the kernel at emission under the ONE readiness lock, so "before" and "after" are total and exact. |
| The countersign demand's ROLE-targeted fan-out resolved at claim | #538 round 4 (a role-targeted push sent to a member who lost standing between claim and send); #546 round 19 (the subject re-judge once per delivery) | The frozen set is re-judged per recipient at the send by `platform_user_holds_role` (the same per-recipient hook), and the subject is re-judged per recipient; the delivered `decider` family keeps the claim-time role resolution with the same per-recipient hook. |

Everything else #552 carried is carried here unchanged in substance: the
six reservation doors installed before the enum values; the `Membership`
and `User` audits with the re-role recovery through the real runner; the
stale-client `countersign-v1` boundary in full; the `ProjectRoleStanding`
kernel register and the `countersignRequired` overlay; the
`MembershipTransition` fact and the three orgs membership commands joining
the ledger; the forward door, the countersign atomicity, the birth and entry
seals, the replaced append-only seal, the stranded resolution and its
departed-holder re-homing, the disagreement's two paths, the finality key
with the kept defaults and the writer sweep, the `ChangeRequest` freeze and
provenance, the bundle-aware provenance binding, the reader enumeration and
its tripwire, the Inbox and Portfolio arms, the catalog ceilings, the
consumer contract bumps with the catalog-data migration in
`ALWAYS_EXECUTE`, the external-effect reseal staging, the `RolloutRetirement`
marker with its transient block, the ONE lock order with leased deliveries
skipped, the per-recipient pre-send hook, the cancellation-by-subject
inventory, the disclosed residual, and the seal-stripped RED discipline.

## §B — The carried §D obligations, elaborated (P31b/P42b, P31c/P34b, P33b)

The merged 4b plan's §D reserved these probe numbers to this unit and bound
each carried question to its probe. The full rows:

4. **P31b/P42b — every register INSERT pairs with its approval act.** EVERY
   `DecisionApprovalRevision` INSERT pairs with its same-transaction approval
   act and authorized decider, under an ACTIVE chain AND an INACTIVE one.
   PROVES: a revision born `finalized = true` with no approval transition on
   a still-`pending` decision is unrepresentable, so the widened finality FK
   can never let provenance trust an approval that never happened. HOW: 4c
   already binds every revision to a COMPLETED `decisions.approve` receipt
   naming this decision (`DecisionApprovalRevision_t4c_provenance`), which is
   the "approval act" half; 4d-i's BEFORE INSERT birth seal adds the chain
   half and a DEFERRED pairing that the same transaction carries the
   decision's approval transition (`pending`/`change` → `approved` under no
   chain, → `awaiting_countersign` under a chain) whose recorded actor satisfies
   the DELIVERED approval authority — the decision's CURRENT holder designation,
   **OR a `pmc` acting on that holder's behalf with the revision's `onBehalfOf`
   naming the designation they stood in for** (#572's review round 14,
   finding 6) — WITH its effects (obligation 7).

   **The on-behalf arm is the delivered path, not a concession**:
   `DecisionsService.approve` computes `onBehalfOf` for a client- or
   named-member-held decision approved by someone who is neither the named nor
   the role decider, records it on the revision and in the event payload, and
   announces it in words (`decisions.service.ts` — *"approved … on behalf of the
   client"*, never disguised). A seal demanding that the recorded actor HOLD the
   holder designation refuses exactly that approval, because a PMC holds neither
   the client's role nor the named member's identity — so 4d-i would have
   rejected an existing, legitimate, already-shipped no-chain approval while the
   legacy-writer table promises every one of them still commits. The seal judges
   the PAIR `(actor, onBehalfOf)` against the designation, which is what the
   service judges; a NULL `onBehalfOf` still demands the holder themself, so the
   arm widens nothing for a writer that does not use it, and a forged
   `onBehalfOf` from a non-`pmc` actor is refused by the `pmc` half. P37 gains
   both holder shapes — a client-held and a named-member-held decision approved
   by the PMC on their behalf, each COMMITTING with its `onBehalfOf` recorded,
   RED against the holder-only rule, which rolls both back — beside the holder's
   own approval and a non-PMC stranger's, refused.

   And the REVERSE: every transition INTO
   `awaiting_countersign` carries its same-transaction provisional revision,
   undisposed, or is refused at commit, so a bare status flip cannot
   manufacture a countersign demand with no head to finalize. RED SITE: the
   hostile insert of a `finalized = true` revision with a forged receipt into
   a `pending` decision — under the active chain (born-true refused by the
   birth seal) AND under the inactive chain (no same-tx transition, refused
   at commit); the inactive-chain bundle WITH the transition but WITHOUT its
   event or audit row, refused at commit. STAGING: 4d-i, seal-stripped run
   (§C).
5. **P31c/P34b — exactly one matching fact per paired transition.** Two
   matching `DecisionForward` rows over ONE holder mutation, and two
   `DecisionCountersign` rows over ONE finality flip, are both refused.
   PROVES: the pairing is one-to-one, not one-to-many — a duplicate evidence
   row would let a second actor claim the same act. HOW: the forward reverse
   seal counts the same-transaction forward rows for the decision and refuses
   > 1 (the holder door already requires the ONE row to match
   field-for-field); `DecisionCountersign` carries UNIQUE `(projectId,
   decisionId, revisionId)` so the duplicate is unrepresentable at the index,
   AND the reverse seal refuses a second row in the same transaction; AND the
   APPROVAL REGISTER: a direct transaction could reserve two valid
   `decisions.approve` receipts under different idempotency keys, make ONE
   transition and insert revisions v1 and v2 citing the two receipts — so the
   register's deferred pairing seal counts the same-transaction
   `DecisionApprovalRevision` inserts per decision and refuses more than ONE,
   exactly as many as the transaction's approval transitions of that decision
   (the lifecycle door admits one), and the birth seal requires the new row's
   `version` to be the decision's next; AND obligation 7 counts the events
   and audit rows the same way — exactly one of each per transition, two
   refused. Absorbed into §A.3's obligation 2 for every future fact. RED
   SITE: the two-row hostile bundles, the two-receipt two-revision bundle,
   the two-event bundle. STAGING: 4d-i.
6. **P33b — the `countersign_rejection` request joins the uniform contract
   as a full row.** Its INSERT pairs bidirectionally with the exact
   `awaiting_countersign → change` transition, validated for its PRODUCER and
   an awaiting subject — a forged disagreement bundle attributed to an
   unrelated user is unrepresentable. HOW: a DEFERRED seal on `ChangeRequest`
   INSERT with `origin = 'countersign_rejection'` requires the same
   transaction to carry the subject's `awaiting_countersign → change`
   transition AND exactly one of the two legal producer shapes — (a) the
   ARCHITECT's disagreement: NO same-transaction `DecisionStrandedResolution`
   for the decision, the chain ACTIVE, and `requestedById` resolving to
   ACTIVE `architect` standing under `phase6_try_readiness`; or (b) the PMC's
   stranded RETURN: a same-transaction `DecisionStrandedResolution` for the
   decision with outcome `'returned'`, the chain INACTIVE, and
   `requestedById` EQUAL to that row's `resolvedById` holding ACTIVE pmc
   authority (`platform_user_orchestration_authority`) — AND a non-NULL
   `sourceCommandId` bound through the bundle rule of §A.3 obligation 6 (the
   request is the primary for (a), the resolution is for (b)) AND the
   `decision.change_requested` event and `change_requested` audit row of
   obligation 7. The decision-side lifecycle seal requires the transition to
   carry exactly one such request. The ordinary `'standard'` request keeps
   its delivered pairing untouched. RED SITE: the orphan rejection request;
   the request attributed to a non-architect under an active chain; a
   returned-bundle request attributed to anyone but the resolving PMC, or to
   an architect; the transition without the request; the rejection request
   with NO `sourceCommandId`, or citing a receipt whose result names neither
   it nor its paired primary; the bundle without its event. STAGING: 4d-i.

## §C — The probe table (P28–P42, plus the carried arms)

Every probe's RED evidence is anchored to the implementation unit's ACTUAL
BASE COMMIT, not to an in-branch shape commit. Every arm whose subject
EXISTS at base (the approve CAS, the holder freeze, the consultation
carve-out, the decider push family, the `withdrawChange` restoration, the
orphan guard) runs as a base-compatible black-box probe — HTTP against the
guarded surface, SQL against the base-migrated schema — executed and
RECORDED against the real base SHA in the packet before any contract, column
or enum is added. Arms whose subject is a NEW table, column, enum value or
seal are executed from the implementation base by the SEAL-STRIPPED
MIGRATION RUN (**BOARD DECISION, not re-litigable** — 2026-08-29, on PR
#480, carried verbatim from the 4c plan §C): the probe harness, checked out
AT the implementation base, applies 4d-i's migration TWICE to scratch
databases — once with the specific seal statement omitted (the omission
performed BY THE TEST, one named object at a time), where the hostile insert
is ACCEPTED, and once whole, where the same insert is REJECTED — both runs
recorded in the packet with their SQL and outcomes. Red sites name where
today's behaviour lives.

| probe | proves | red site / staging |
|---|---|---|
| P28 | the role in every mirror: `TokenRole`, both zod enums, `PushRole`, `KNOWN_ROLES`, the manifest permissions, `ROLE_POLICY` (the exact row set), the schema comment, the web role lists and pickers; the DESIGNATION in every mirror (`DeciderKind`, `DECIDER_KINDS`, the shared type, `viewerIsDecider`, `deciderNoun`, the picker, the audience selectors, the `deciderPush` architect arm and the `deciderPushTarget` arm — a published architect-designated decision's RECIPIENTS are every active architect's links and no client link, RED at base where the fallthrough targets `client`); the widened targeted-catalog ceilings; `countPending`'s architect and awaiting arms; a decision published to an architect holder and a consultation requested from an architect end to end; **P28b** the dark delivery — the six reservation doors (the `User` door installed under the `User` table lock before the audit), including the audit register's KIND door — a `countersigned` row refused on a `pending` decision, where the weak correspondence's table has no entry and judged nothing at all, and on an `approved` one, where the approval's own event answered it (#582 round 15, finding 2), the `Membership`/`User` audits barrier-probed in both orderings on the shipped file — the `User` writer too (writer-first → ABORT; migration-first → REFUSED), the abort → re-role → `migrate resolve --rolled-back` → redeploy recovery driven through the REAL runner for an active row, `ensure-accounts` refusing an `ACCOUNTS_JSON` with an `architect` entry before any row is written (no `User`, no `Membership`) while the `pmc`-only file provisions and the `AUTO_ENSURE_ACCOUNTS=true` boot over the refused file fails closed naming the entry, a soft-removed row and a dev `User` fixture, the service refusals BEFORE any write (an architect added by a NEW email while reserved → 409 and ZERO `User` rows; after 4d-iii the member is created), the dev session refusing `architect` before either branch while reserved and the synthetic fallback never minting it, and the `ALWAYS_EXECUTE` replay arms — a post-4d-iii database holding an active architect replays 4d-i, finds the marker, installs no door and no refusal function, aborts nothing; a pre-4d-iii database still installs and audits; the `ROLE_POLICY` EQUALITY pin — `architect` in an action's role list iff the action is one of the eleven — `decision.change` NOT among them (#572's review round 3, finding 3) — a widening onto any commercial or payment action, `decision.change` re-admitted, and an omitted read all RED | the role vocabulary, the designation contract, the reservation, the audit, the runner |
| P29 | no-active-architect byte-identity: with no architect membership ever, approve lands `approved` directly with `finalized = true`, forward works for holder/PMC and is refused for the missing role's authority, `countersignRequired` is absent, a `standard` origin is omitted, the whole 4b/4c surface is byte-identical (the wire-shape tripwire); **P29c** mixed-version byte-identity — with the reservation ARMED every project is chain-off, no row can be `awaiting_countersign`, no membership can be `architect`, no `DecisionForward` row, `decision.forwarded` delivery or architect-designated row (draft or published) can exist, no Forward renders, every read a pre-4d instance performs sees only values its enums know; and the STALE-CLIENT arms — every strip / refuse / additive-ignorable classification of the completeness tripwire exercised for `recorded-v1` and `countersign-v1`, the activation-between-check-and-approve barrier in both orderings, an architect signing in through EACH token-minting route refused for the lesser client and served for the newer, after 4d-iii | the whole 4b/4c surface; the interceptor; the four in-command contract checks |
| P29b | removed-architect deactivation + the stranded decision: the chain deactivates for NEW approvals; `decisions.resolveStrandedCountersign` drives BOTH outcomes with their bundles and their effects (the `completed` outcome emitting by `approvedFrom`; the `returned` bundle's request authored by the resolving PMC and admitted by P33b; the returned-resolution bundle MISSING its request refused; a whitespace-only reason refused at zod AND the CHECK); the bare hostile awaiting flip under the INACTIVE chain refused without the fact; refused while an architect is still active; the architect-reappears race deterministic; the departed-holder `returned` with a target re-homing into `change` with the forward fact, without one refused; the EMPTIED ROLE designation likewise — the sole architect approves an architect-designated decision and leaves under the exemption, the `returned` with a named active target re-homes with a forward FROM the role and the open-holder rule never fires, without one refused 400 (RED against the named-holder-only rule, which let the transition reach the seal and be refused there); the window-rule race fixture — the `Project` INSERT and the owner/admin `OrgMembership` INSERT resumed in both orders before the doors exist, the owner left without the fanned-out `pmc` row — then the owner's consultation request COMMITTING under the delivered requester arm, their `MembershipTransition` with `actorRole = 'pmc'` COMMITTING under the race-free derivation, and a delivered `pmc` push resolved on that project INCLUDING them, the same three after 4d-iii's re-projection through the repaired register (RED against the 4d-i re-point, a fact seal reading the fanned-out row alone, and a participant wrapping the register while reserved); the RE-NOTIFICATION — approve → A removed → B added, exactly one new `decision.awaiting_countersign` delivery per still-awaiting decision, B and only B receives it, the `countersign_renotified` audit row naming the crossing event and the transition; the HAND-RUN sequence — A removed and B added by receipt-backed direct bundles carrying their events: the same one delivery and the same audit row; A-active/B-added: no crossing, nothing re-emitted, B's Inbox item present; the register after EVERY transition shape, written only through `platform_role_standing_apply` from the orgs-owned trigger (a direct call at statement depth refused; a direct write refused); the crossing event on every architect activation/deactivation and the second session's tab refreshing its modal copy; the ineligible-actor fact refused; a fact whose `actorRole` the actor does not hold, or whose `actorName` is not the account's, refused, and the pair frozen against a later rename or re-role; an org owner/admin with an active architect membership re-roling and adding THEMSELVES through the service accepted by the seal (the owner/admin arm live), a PMC's self-demotion accepted with the fact judged before the flip (the live read IS the pre-state), a PMC's self re-role to `engineer` committing with the frozen `actorRole = 'pmc'` (RED at the post-state live check), a hostile bundle writing the membership BEFORE its fact refused by the membership seal, a fact claiming a role its actor does not hold refused, a contractor's self-transition refused; every direct-write refusal of §A.2's membership paragraph — the whole-event binding arms (`role: 'engineer'`, a non-active `to`, a `from` or `membershipId` not the fact's, an envelope pair not the fact's) each refused at commit and the standalone crossing event with no fact refused by the kernel's pairing seal as unclaimed, a direct write to the claim register and a statement-depth call of `platform_claim_event_pairing` refused, a second claim for one event refused (#568's review round 1, finding 2); the CLAIMANT DERIVATION exercised on the branch whose bundle the hand list had missed (#572's review round 9, finding 1) — a direct approve from `change` COMMITTING its valid REAPPROVAL bundle (`DecisionApprovalRevision` + the `ChangeRequest` closure around one `decision.reapproved`) with the revision the sole claimant and the closure verification-only, the same approve from `pending` committing with the same claimant and NO closure at all (which is why the closure cannot be the claimant), the closure ALSO claiming refused on the register's per-event UNIQUE, and the closure claiming INSTEAD of the revision refused as unclaimed on the `pending` arm; with `decisions.effects` asserted to record NO delivery for any of them; the NO-HEADER arms — each of `members.add`, `members.updateRole` and `members.remove` driven against the 4d-ii-a server exactly as a deployed tab calls it, with NO `Idempotency-Key` under the documented default, COMMITTING its `MembershipTransition` with a non-NULL synthesized `sourceCommandId` and its receipt (RED against the keyless writer, which rolls back at the fact insert), and each driven WITH a client key replaying exactly once (#572's review round 3, finding 4); the cascade probes; the backfill REPLAY — 4d-i re-run over a MATURE database that already holds a row for every project of the original backfill AND a project created since without an architect, committing: the new project's zero row inserted under the gate, no existing row touched, and the same insert outside the gate refused (#572's review round 9's sweep — RED against a seal arm predicated on the target row's ABSENCE, whose BEFORE INSERT trigger raises on every already-present project before `ON CONFLICT DO NOTHING` is reached, so the replay aborts on exactly the databases replay exists for); the OPERATOR ACTIVATION's probes live in the companion document with the register they exercise (P-A1..P-A11 there); the per-user registers — `ProjectUserStanding` and `UserIdentity` equal to the orgs truth after every membership shape (activate, deactivate, remove, restore, re-role in and out), an org owner/admin gain and loss fanned out over every project of the org, a new project seeded with the org's owners and admins, a display-name change, and the project cascade, with a direct write to either register refused; an org owner/admin gaining an active `engineer` membership losing the membership-less `pmc` row and regaining it when that membership ends; a user provisioned after 4d-i holding an identity row from the insert and their later fact accepted; an org owner/admin holding an active `engineer` membership recording a `MembershipTransition` with `actorRole = 'engineer'` and committing (authority from the `OrgUserAuthority` row), the same fact with `actorRole = 'pmc'` refused, a plain engineer's refused for want of authority; the delivered `approve`'s notice-then-emit order committing under the deferred FK, a notice naming an event that never arrives refused at commit; a legitimate `decisions.effects` re-emission after crossing Q accepted with its own event excluded from the latest-demand lookup; `OrgUserAuthority` equal to the orgs truth after an owner/admin insert, promotion, demotion and removal, and after 4d-i's backfill; a forward to a `client` role designation with a live holder admitted and to one without refused the FROZEN-PAIR SPLIT (#572's review round 12, finding 3): round 11's held-rename barrier driven for the NAME half (a rename held open by a second session while a fact-writing command runs, COMMITTING in both resume orders with the frozen name matching whichever rename won, RED against the pre-transaction read), and beside it the ROLE half under the window race — the membership-less org owner/admin left WITHOUT the fanned-out `pmc` row records a `MembershipTransition` with `actorRole = 'pmc'` and COMMITS, its role resolved by the race-free derivation, RED against a writer that resolves the whole pair from `ProjectUserStanding`, which resolves NO role for that actor and leaves an authorized command unable to name the role it acts in; the same command after 4d-iii resolving through the repaired register; and a re-role held open across the same command asserted to COMMIT in both resume orders, so the in-transaction discipline round 11 established holds for the role too and only its SOURCE changed; the LOCK-ORDER arm — a fact-writing command and a concurrent membership write on the same project interleaved in both orders with neither deadlocking, the identity row taken AFTER `Membership`, which is the order the orgs standing trigger already takes; the MEMBERSHIP-TRANSITION CASCADE (#572's review round 12, finding 5): a receipt-backed NON-architect transition committed on an event-free project (a fact, and no `DomainEvent`, the crossing event being demanded only of architect-standing flips), that project then hard-deleted and the delete SUCCEEDING with the fact, the memberships and the register rows gone — RED against the append-only seal without its cascade arm, which aborts the delete on the fact rather than on the row it describes — while a direct `DELETE` of that same fact outside the cascade stays refused and the hard delete of a project holding an active architect stays refused at the tenant FK with the event, the fact and the register row intact | the stranded command; the standing register; `decisions.effects`; the membership seals |
| P30 | forward authority (holder/PMC/architect), ACTIVE target only, eligible states only — terminal AND `awaiting_countersign` refusals both probed through the guarded HTTP route with the shared `ROLE_POLICY` action | the forward command |
| P31 | the `awaiting_countersign` lifecycle: approval under a chain lands it with `finalized = false` — a revision BORN `finalized = true` under an active chain refused by the INSERT seal; the provisional approve from `pending` with the frozen approval tuple written AND the chain reapproval from `change` each COMMITTING through the widened `decision_t4b_attribution_seal` (RED at the delivered function, which refuses both — #567's review round 2, finding 3); the countersign is ONE atomic act sealed from BOTH sides (the boolean-only hostile flip refused; the orphan countersign row refused at commit; the split two-transaction replay refused; the REPLACED append-only seal — a DELETE and an UPDATE of any column other than the flip refused, the paired flip accepted, the delivered `_append_only` trigger absent by name after 4d-i) AND attributed to an ACTIVE architect AND carrying provenance (the 4c arms verbatim) AND carrying its EFFECTS — the finalizing event by the revision's recorded `approvedFrom` (the reopened → reapproved-into-awaiting → countersigned sequence end to end, with the `approved`/`reapproved` + `countersigned` audit rows), a countersign bundle WITHOUT its event, WITHOUT its audit row, WITHOUT its feed row, with TWO events, or with an event naming another actor, or whose event envelope carries a role or name other than the fact's frozen pair, each refused at commit (the no-chain approve's event with a NULL pair accepted before 4d-iii and refused after); the ENTRY sealed from the decision side (the bare transition with no revision, the re-entry onto a disposed head, the transition under an INACTIVE chain, each refused; the legal approve accepted with its provisional notice bound to its event); the awaiting ENTRY's bundle demanding exactly one `decision.awaiting_countersign` event — a receipt-backed hand-run entry WITHOUT it refused at commit, one carrying a `decision.approved`/`reapproved` instead refused, the legal entry's event carrying the architects frozen as `targetUserIds` and the payload's provisional act; a `DecisionEvent` UPDATE, DELETE and TRUNCATE each refused after a valid transition (the audit row as immutable as the fact); a countersign bundle whose feed row carries the wrong `kind`, or a `kind` with no `eventId`, refused at commit, and a feed row committed with a forged `text` RENDERED from its kind and event — the forged string served to no client, live, projected or rebuilt; a kinded row's `eventId`/`kind`/`decisionId` UPDATE (a NULLing included) and its DELETE refused, a forwarded pending decision withdrawn keeping its kinded notice hidden from every non-PMC viewer, and a kinded `decision.forwarded` notice ABSENT from a contractor's snapshot while the decision is hidden from them and PRESENT for the PMC and the holder; the awaiting entry's event with its push omitted, with a subset or superset of the active architects frozen, or with a body other than the catalog's constant, each refused at commit, and the exact set admitted; an audit row whose `actorName`, `actor` label or a named payload field disagrees with the fact refused; the seed's reset and the fixture's wipe succeeding on the 4d-i schema with `DecisionEvent_t4d_append_only` installed and enabled afterwards, every swept suite's cleanup succeeding through the helper, the bypass tripwire RED on a planted private `DISABLE TRIGGER` AND on a planted unguarded `decisionEvent.deleteMany`, the three rewritten precision arms asserting the append-only refusal by message with the approval guard's message still first on evidence rows, the two whole-table reset transactions passing; a feed row for project A bound to project B's event refused by the composite FK and the same-project binding accepted; the converse trigger: a standalone `decision.approved`, `decision.awaiting_countersign`, `decision.change_requested` and `decision.forwarded` each refused at commit without its fact, the consumer's `renotified` re-emit with its `countersign_renotified` row accepted; the frozen `approvedByName`/`approvedByRole` on every 4d-ii revision, a rename between the acts carrying the act-time name; the reader tripwire RED for the value the moment it exists; the Inbox item and badge; the architect's controls as a product path; the consultation carve-out and the response push for an architect requester; the web arm driving the client approval path under an active chain asserting the provisional copy; the converse admitting the countersign's and the `completed` resolution's finalization without a new revision row and refusing a standalone `decision.approved` with none of the three; the PMC's feed after a forwarded pending decision is withdrawn showing the withdrawal notice and neither the published nor the forwarding notice, both rows and events still present; every 4d-ii `decision.approved`/`reapproved` event carrying the exact `revisionId` (direct approve, countersign, `completed` resolution), the converse refusing an event naming a revision no same-transaction finalizer touched, a drain-shaped event without `revisionId` admitted through the same-transaction insert fallback and refused after 4d-iii, and an older kinded green notice of a twice-approved decision rendering ITS revision's approver, not the head's; the shell badge — `shellSummary.pendingDecisions` equal to `countPending` for the architect with one `awaiting_countersign` decision and no pending one, and for the PMC with a stranded one; **P31b/P42b** and **P31c/P34b** (§B) | `decisions.approve`; the register; the readers |
| P32 | self-countersign is TWO attributed acts under two idempotency keys — one combined act is refused; the two acts appear as two ledger receipts and two register facts | the countersign command |
| P33 | both disagreement outcomes: origin-stamped open `ChangeRequest`, `withdrawChange` refusal on `countersign_rejection`, the class-wide evidence freeze INCLUDING `decisionId`, `origin`, `revisionId`, `projectId`, `sourceCommandId` and the frozen role/name pair (the re-point, the re-label, the NULLing and the replacing UPDATEs each refused), impacts rendered, reject-back AND forward-on driven through re-approval to completion — forward-on through the ONE forward door with its `DecisionForward` fact (the request the bundle's provenance primary, the forward citing the same receipt); the `origin` serialized only when non-`standard` on live, projected and rebuilt DTOs and the Withdraw affordance SUPPRESSED for a rejection request while the direct call still 409s; the direct-SQL disagreement bundle by an ACTIVE architect with every pairing, standing and eligibility seal green but NO receipt refused at commit, and with NO event refused at commit; the standard request's receipt naming the request row (naming the decision refused at commit; the keyed replay appends nothing); a `standard` request INSERTED without the same-transaction `approved → change` transition refused at commit and the transition without its open request refused — the reviewer's shape: after the sole architect leaves an awaiting decision, a database-role writer's planted standard request cannot occupy `ChangeRequest_one_open_per_decision`, and the stranded `returned` resolution creates its rejection request (#568's review round 1, finding 3); the STANDARD origin's own arms driven through the SHIPPED `requestChange` after 4d-i's seals by a non-PMC caller — an ACTIVE engineer's standard request on an `approved`, published decision COMMITS with the frozen `engineer` pair, a contractor's and a consultant's likewise, an architect's is refused by the delivered `decision.change` policy exactly as today, and a direct standard insert attributed to an inactive member is refused at commit (#572's review round 2, finding 2 — RED against the two-role enumeration, which would have refused every non-PMC standard request the delivered policy admits); the MEMBERSHIP-LESS arm — an org owner/admin holding NO `Membership` on the project, signed in through the delivered `ProjectAccessService` `pmc` path, opening a standard request through the shipped service after the trailing seals COMMITS with the frozen `pmc` pair (the register's derived row is the standing), and a direct standard insert attributed to a user who holds NO standing at all — no membership, no derived row — is refused at commit (#572's review round 3, finding 2 — RED against the active-member rule, which would have refused the owner/admin the delivered access path admits); the WINDOW arm of both — that same owner/admin left WITHOUT the fanned-out `pmc` row by the drain-window race, their standard request COMMITTING under the race-free authority derivation and their `withdrawChange` closure likewise, then both again after 4d-iii through the repaired register (#572's review round 5, finding 3 — RED against an arm judging `pmc` through the fanned-out register alone); the CLOSER arms, which round 4 promised this row and did not add (self-found in round 5, and the same §A-corrected/table-unswept shape as findings 1 and 2 of that round): a withdrawal bundle citing a real `resolvedById` with a role or name the registers do not give that user REFUSED at commit (#572's review round 4, finding 2), and a bundle with a TRUTHFUL resolver pair, a real `change → approved` restoration, its event and its audit row but NO reserved `decisions.withdrawChange` receipt — no `resolvedByCommandId` — REFUSED at commit, with the same bundle through the SHIPPED command COMMITTING (#572's review round 5, finding 5 — RED against the pair-only rule, which the receiptless bundle satisfies); the ORIGIN prohibition proven REACHABLE (#572's review round 12, finding 1): the round-11 hostile `open → withdrawn` on a `countersign_rejection` request is refused by ORIGIN when it carries a complete truthful resolver set and a PMC resolver, and the SAME transition with `resolvedById` left NULL — the shape that used to slip past the arm entirely — is refused by the closure arm before origin is judged, both leaving the request open and its decision in `change`, RED against the resolver-keyed arm, under which the second commits; **P33b** (§B.6) | the `ChangeRequest` machinery; the disagree command |
| P34 | the forward chain: attribution (actor vs displaced holder), the web Forward affordance following `rollout.phase6_4d`, the `decision.forwarded` emission + re-seal, the NON-HOLDER architect's product path (RED at base where the audience rule hides the row; absent for a removed architect and while the chain is inactive), the non-blank reason at both layers, the PAIRING sealed in BOTH directions (no row; a mismatched row; the orphan row; the same-target no-op at both doors), the DOOR status-gated (a matched forward on an `approved`/`recorded`/`withdrawn` decision refused; on an `awaiting_countersign` decision refused WITHOUT the same-tx rejection request), the TARGET's and the ACTOR's standing judged at the DB (a removed membership, an empty role, an inactive actor, an unauthorized actor, the role-holder arm's own case), the frozen `forwardedByRole`/`forwardedByName` judged (a hand-run forward by an active PMC freezing `architect` refused; a name that is not the account's refused), the forward bundle WITHOUT its event, audit row or notice refused at commit; the forward push's recipients FROZEN at emission (a role `toDesignation` resolved to its holders under the lock; the delivery payload carrying them) | the forward door; the attribution seal; the forward command |
| P35 | the forward-vs-approve barrier: both orderings deterministic, exactly one surviving outcome, a coherent holder; forward-vs-countersign likewise; every cancelling command vs a concurrent claim in both orderings under the ONE lock order, no deadlock | the row-lock serialization in the canonical order |
| P36 | the switch-writers barrier: architect role-change vs approve, activation AND deactivation, both orderings — the SERVICE activation and the HAND-RUN one (a direct INSERT under a hand-completed receipt with its fact and event) each vs `approve` and vs the stranded resolution, the hand-run writer refused as contended while the key is held and the terminal state asserted (approve-first → the activation lands after and the decision stays `approved`; activation-first → the approve lands `awaiting_countersign`); the orgs role mutations for `architect` in the §A enumeration; activation-vs-approve asserting the countersign deliveries per decision EXACTLY by ordering — approve-first under NO chain owes ZERO; activation-first → the approve's OWN emission is the ONE; a decision already awaiting when the activation crosses receives the ONE re-emit; never two for one decision; the ordered handlers' P-before-Q sequence with an approve landing between them; the NON-architect standing writers serialized — forward-to-`client`-role vs a direct insert of active client B in BOTH orderings (B-first → frozen set {A, B}; forward-first → B REFUSED as contended by `Membership_t4d_readiness`'s message, accepted after the commit, the frozen set equal to the audience at commit), the same for an `engineer` provisioning sign-in vs a forward to `engineer`, and for a forward to the `pmc` role vs an `OrgMembership` owner insert (B-first → {A, B}; forward-first → the org write REFUSED by `OrgMembership_t4d_readiness`, the frozen set equal to the audience at commit) — RED in the seal-stripped run where B commits mid-forward; the STALE ACTIVATION — B activated (Q) and removed (R) before the consumer reaches Q: Q recorded `noop` with `stale_activation`, no re-emit, no dead-letter, R handled next and cancelling the unsent pre-Q demands, the consumer's cursor past both; Q → R → S with C active at handling: exactly ONE fresh demand, frozen to C, S skipped — RED where the Q handler re-emits unconditionally and the empty-audience seal dead-letters it; PROJECT CREATION vs an owner insert for the same org in BOTH orderings, then a forward to the `pmc` role on the new project asserting no committed effective holder absent from the frozen set — RED in the seal-stripped run where the phantom lands; the same with a DIRECT `Project` insert (refused as contended by `Project_t4d_org_readiness` while the owner write holds the key, accepted after) — RED where the table door is omitted; demotion-vs-creation in both orderings (demotion-first → 403 at the in-key re-judge; creation-first → the project stands) — RED at base where the authority read precedes the transaction; a hand-run `renotified` bundle citing an activation crossing that PRECEDES the decision's latest demand refused by the converse, one citing a crossing at or after it admitted | `lockProjectReadiness` on the orgs role mutations, the four other `Membership` writers and the org owner/admin writers; `lockOrgStanding` on project creation and the org writers; `Membership_t4d_readiness`/`OrgMembership_t4d_readiness` (4d-iii); `decisions.effects` |
| P37 | EVERY entry into `approved` sealed behind the chain, SERIALIZED by `phase6_try_readiness`: under an ACTIVE chain the direct `pending → approved` hostile flip refused, the finalized-boolean-only flip refused, the awaiting-flip without the SAME-TX countersign ROW refused, a published `Decision` INSERTED already carrying `awaiting_countersign` refused by the entry seal's INSERT arm (RED against the UPDATE-only arm — #567's review round 2, finding 2), the standard `withdrawChange` restoration PASSES, the `countersign_rejection` restoration refused; under an INACTIVE chain direct approval legal ONLY from `pending`/`change` AND ONLY WITH ITS BUNDLE — the receipt-backed direct bundle with revision, transition, event and audit row ACCEPTED, the stream advanced and the `decisions.inbox` fold applied; the same bundle without its event refused at commit; with two events refused; with an event whose `actorId` is not the revision's approver refused; with the audit row missing refused; an event inserted at the stream's `nextPosition` without the increment refused by the envelope seal, one at an already-taken position refused by the uniqueness, a second event after one increment refused, an increment by two refused by the allocation seal, an increment with no event at the allocated position refused at commit (no gap, no double allocation representable); an event of a `pairingRequired` type with no same-transaction claim refused at commit by the kernel-owned seal and a claim planted directly refused by the register's writer-depth seal (#568's review round 1, finding 2), the `insertRawEvent` fixture's insert admitted and the delivered envelope arms passing unchanged, a legacy plant admitted only inside its named bypass and refused outside it, the raw-insert tripwire RED on an unlisted site; an intent naming an unknown `(coverageVersion, effectKey)`, a key whose catalog `eventType` is not the event's, a mismatched `invalidate`, a push outside the ceiling, or `targetUserIds` on a family without a frozen audience, each refused, and an intent copied from the catalog row admitted; after 4d-iii, an event of either kind without the envelope pair refused and every write-through emitter — a PO issue and amendment, a labour PO, an inventory receipt, a measurement, the activation CLI, the re-evaluate CLI — committing `commercial.money_moved` WITH the pair (RED at base where `AttributionActor` drops the name) AND with its delivery rows derived from the persisted catalog by a process that booted no registry (RED at base, where `materializeDeliveries` writes nothing without one); a `dispatch` row whose `payload.body`, `roles`, `targetUserId` or `targetUserIds` differs from its event's intent, or whose `subject` is not the event's `entityId`, refused at insert, the previous release's `{body, roles, targetUserId}` shape admitted for an intent without `targetUserIds`, an UPDATE of a delivery's `payload`, `subject` or identity refused, the 4a cancellation mark (`dispatch → noop` with `cancelledAt`, payload preserved) admitted and a bare `deliveryAction` flip refused; without a feed row bound to the event refused, and BEFORE 4d-iii the previous release's write shape (feed row with NULL `eventId` and NULL `kind`) accepted — the bare awaiting-flip refused without the stranded-resolution fact; the first-architect-activation-vs-approval barrier deterministic in both orderings; a `DecisionConsultation` or response inserted without its same-transaction `decision.consultation_requested`/`responded` event refused at commit, the event without its fact refused, the delivered service path unchanged and accepted; a `ProjectEventStream` row DELETE refused, an INSERT at `nextPosition ≠ 0` or for a project holding events refused, the project-deletion cascade admitted; a delivery's `cancelledAt` cleared, rewritten, or set outside the mark's statement or the leased/dead mark-only arm refused, the mark itself admitted; a `decision.approved` bundle without its push, or with `roles` narrower than the broadcast ceiling, refused and the delivered shape admitted; the envelope insert and the gated retirement stamp under the barrier in both orderings — an intent retired before the insert's lock refused, one retired after the insert's commit admitted, never an event on a retired intent; a consultation request or response whose envelope pair differs from the fact's frozen pair refused, a request event targeting a user other than the frozen consultee or a response event targeting a user other than the requester refused; a chain check reading `platform_role_standing` equal to the orgs truth after every architect transition shape; the relay's leased-cancel completion and its pre-intent neutralization admitted by the frozen-delivery seal, a bare `dispatch → noop` on an unmarked row with an intent refused; a delivery row planted for an INACTIVE consumer whose action contradicts its persisted rule refused at insert, one that matches admitted and left in place by the next expansion pass; a writer minting its event id, stamping the notice first and emitting second committing with the deferred FK satisfied; the architect arm of both 4b seals judged from `ProjectRoleStanding` — an architect-designated open decision refused with the register at zero and admitted once the orgs trigger writes the row — and the boundary tripwire asserting the seal functions' architect branches name no orgs table; a hand-run demand whose `targetUserIds` is `[A, A]` for one active architect refused, `[A]` admitted, and a delivery row carrying a non-canonical copy of a canonical intent refused; with a published `pending` decision designated to the architect role and ONE active architect, that membership's removal, deactivation and re-role each REFUSED by `Membership_t4b2_holder_guard`'s architect arm reading the post-write register, TWO architects removed in one statement refused likewise, and TWO standing flips across two statements in ONE transaction refused at commit by the per-project rule — the interleaving that would otherwise let both events carry the same final `activeCount` and be classified non-crossings (#572's review round 20, finding 1), and the same removal admitted once the decision is resolved (RED against the AFTER-ordered register trigger, where the guard read `1` and the count landed at zero) | the status-transition seal + obligation 7 |
| P38 | the pre-send eligibility guard generalized to EVERY targeted decision push through PER-EVENT-FAMILY predicates — the two NEW families (`countersign`: awaiting + active architect; `forward`: installed holder AND `pending`/`change`) beside the three delivered: one positive AND one negative per new family; a valid consultee push NOT dropped by the countersign predicate; the responded predicate widened to the architect requester WITH the withdrawn-audience arm; a REQUEST push enqueued before a withdrawal cancelled for every consultee; the two new predicates bound under the BUMPED `webpush.notify` contract (`catalogVersion` 2 → 3), a process compiled at the old version refused by `syncConsumerCatalog` at startup, the catalog-data migration in `ALWAYS_EXECUTE` (a P3005 baseline over a pre-4d-ii database runs it and the upgraded process starts), a SECOND execution of 4d-ii's catalog file over an already-registered database a no-op; the `decisions.effects` REGISTRATION over a database holding historical events — every historical delivery `succeeded`/`noop`, zero notifications, zero `countersign_renotified` rows; the external-effect RESEAL sequence — the 4d-ii build refused in outbox mode under the 4d-i seal, served in shadow, resealed, then booting in outbox mode; the PERSISTED catalog — 4d-i's seeded rows equal to `canonicalCatalog()` at its coverage version (the tripwire), an intent at the pre-4d-ii version admitted through the drain while 4d-ii's rows stand beside it, refused after 4d-iii retires them, the singleton seal version equal to the newest UNRETIRED persisted version at boot, a direct UPDATE, DELETE or TRUNCATE of the catalog refused; `targetUserIds` admitted by `buildDispatchIntent` only for the two frozen-audience families and refused elsewhere; the response push of a requester re-roled between request and response carrying the FROZEN request-time role, a `consultation.request` whose `requestedByRole` the requester does not hold refused by the INSERT seal, a legacy NULL-role consultation's response pushed as `pmc`; the ACTIVATION boundary — a direct `UPDATE` of `OutboxConsumerCatalog.active` or `registeredAt` refused, an appended `OutboxConsumerActivation` row flipping the mirror, an UPDATE or DELETE of the register refused; a consumer deactivated for event N (no row demanded, the seal passing) and reactivated at N + 1 receiving N's row from the next expansion pass and its ordered cursor advancing through N; `decisions.effects` registered inactive with no row demanded of a pre-4d-ii-shaped emit, activated by 4d-iii's appended row with every historical delivery `succeeded`/`noop`; a direct `UPDATE`, `DELETE` or `TRUNCATE` of the activation register refused, a blank or all-whitespace `reason` refused; a `ReleaseLease` row's `instanceId`/`release`/`catalogVersion`/`startedAt` UPDATE refused, a `leaseUntil` decrease refused, DELETE and TRUNCATE refused, the renewal admitted; two activation appends under the deterministic barrier in both orderings, split by WHO appends (#572's review round 24, finding 3 — this arm predated the companion document's round-2 finding 3 and kept the pre-protocol expectation): two OPERATOR requests through `outbox:consumer` with distinct request tokens BOTH COMMIT, because the protocol locks the catalog row BEFORE deriving `activationSeq` — the second blocks, re-reads the first's committed head and appends after it — with the terminal mirror equal to the SECOND request's intent and P-A5's pre-lock rendezvous the staging; while two DIRECT appends that bypass the protocol and precompute their sequences leave the second refused as stale by the head-lock trigger, which stays as the floor under direct writers. Asserting a refusal for the operator pair would have certified an implementation that derives before locking and silently loses one valid request, which is the shape the companion's probe was redesigned to make RED; the mirror equal to the highest committed fact in both cases, never reordered; an event and an activation append under the barrier in both orderings — the activation before the event's read owed a row, the activation after the event's commit owing none, never an event without a row for a consumer active at its commit — and the exact read → activation → commit interleaving against an INACTIVE consumer: the event's transaction takes its read with every catalog row locked, that consumer's included, the activation's `FOR UPDATE` then observed BLOCKED in `pg_stat_activity` until the event commits, the event owing no row and the activation applying after it, RED against a lock over the active rows alone, where the activation slips between the read and the commit and the event commits without the row (#567's review round 1, finding 3) | the per-family registration + the two new `decisions.*PushTarget` queries + the consumer catalog bump |
| P39 | the delivered orphan guard EXTENDED: removing or re-roling the NAMED holder, or the last active member of a ROLE designation, of an `awaiting_countersign` decision refused at BOTH layers (409 through `holdsOpenDecisions`; the DB guard on the hostile direct write); removing the LAST ARCHITECT NOT refused — it deactivates the chain (P29b) — INCLUDING when that architect is the named holder or the last member of the architect ROLE designation an awaiting decision names (the one named exemption), while a named holder who is an architect but not the last is refused naming the pending countersign, and a `pending`/`change` decision designated to the role still refuses removing its last architect | `holdsOpenDecisions` + `phase6_t4b2_membership_guard`, open set widened |
| P40 | the send boundary per family (§A.2): the claim-time re-target (the `deciderPushTarget` read taking the decision row lock); the invalidation-vs-claim barrier in both orderings for the decider, forward, countersign (the frozen-set arms), user-targeted and consultation families; the direct-transition arm and the fan-out arm; the archive arm — the delivery dropped with the mark at the pre-send barrier and NOTHING re-notified on restoration, the awaiting decision served to the architect's next read; the responded family's target-aware re-judge; the withdraw-vs-respond barrier in both orderings; the delivery row after a partial fan-out `succeeded`/`dispatch` with NO mark, marked only when every resolved recipient is stale; the consultee push surviving each; the residual stated per family | the consumer's per-recipient hook; the cancellation inventory |
| P41 | the delivered 4c lock-order + terminal-state probe EXTENDED to the transitions 4d adds that CLOSE the consultation-open set: `consultation.request` and `consultation.respond` vs the COUNTERSIGN, vs the `completed` stranded resolution, and vs the standard `withdrawChange`, each in BOTH orderings under the canonical lock order, asserting the TERMINAL invariant directly — consultation-first leaves the historical consultation/response standing and the finalizer commits `approved` beside it; finalize-first returns 409 with NO consultation row, NO response row and NO `consultation_*` effect; the `returned` resolution and the countersign REJECTION land `change`, which stays in the open set, so the same probe asserts the consultation ACCEPTED after them; no deadlock abort in either ordering | `decisions.service.ts` `requestConsultation` / `respondToConsultation` (the delivered 4c commands — there is no `consultations.service.ts`); `decisions.countersign`, `resolveStrandedCountersign`, `withdrawChange` |
| P42 | the finality candidate key over the ACTUAL provenance columns: provenance onto an unfinalized revision unrepresentable (both spec tables); `finalized → false` under reference refused by the FK; the additive backfill leaves every legacy revision `finalized = true` and every legacy spec row `revisionFinalized = true`, proven over the legacy fixture in `upgrade-proof.sh`; the DEFAULTS hold through the drain — a revision, a material spec and a labour spec inserted WITHOUT the new columns all succeed on the 4d-i schema and land `true`, a `ChangeRequest` inserted WITHOUT `projectId` is filled from its decision and one naming another project's id is refused by the composite FK, a `Notification` inserted WITHOUT `eventId` succeeds; 4d-iii's drop of the defaults probed by the same inserts then failing AND by a current-version provenance write through the SHIPPED writers — create, revise AND cancel, material and labour — succeeding with `revisionFinalized = true` from the widened `approvedRef` (RED at base); 4d-iii's trailing seals — a NULL-`sourceCommandId` standard request refused while the legacy NULL rows survive, AND the SHIPPED `decisions.approve` driven from `change` after the trailing seals, closing a `standard` request and, in a second arm, a `countersign_rejection` one, each COMMITTING with a non-NULL `resolvedByCommandId` AND a non-NULL frozen `resolvedByRole`/`resolvedByName` pair on the row it closed, its receipt binding accepted through the closure's `decisionId` arm (#572's review rounds 6 and 7 — RED three ways, each alone: against a writer taught only the withdrawal path, against one taught the column but not the frozen pair, and against a binding rule admitting only the row or a bundle primary, where an ordinary re-approval rolls back at the seal); the SHIPPED `decisions.withdrawChange` driven after the trailing seals asserting the SAME three (#572's review round 7, finding 2's sweep — its receipt also names the decision, so it fails the unextended binding exactly as the re-approval does); the AUTHORITY probe on that arm (#572's review round 10, finding 1): a truthful-but-UNAUTHORIZED closer — an ACTIVE engineer who is neither the requester nor a PMC, carrying the receipt, the frozen resolver pair, the restoration, the event and the audit row, every other seal satisfied — REFUSED, while the requester's own identical closure and a PMC's both COMMIT (RED against the completeness-only arm, which admits all three); the UPDATE-ARM hostile probe (#572's review round 8, finding 2): a DIRECT closure setting `resolvedById` alone — the decision restored, the event and audit row appended, every other seal satisfied — REFUSED at the trailing seal's UPDATE arm, and the same closure refused again with the receipt but WITHOUT the frozen resolver pair and with the pair but WITHOUT the receipt, so the arm is proven to require the set and not merely one of it; RED against an INSERT-only seal, which every one of those closures passes because it inserts nothing; the CLOSURE-ARM KEY probe (#572's review round 12, finding 1): a direct `UPDATE "ChangeRequest" SET status = 'withdrawn', resolution = 'withdrawn'` that leaves `resolvedById` NULL — with the decision restored `change → approved`, the event and the audit row appended and every other seal satisfied — REFUSED, and the closure completed WITHOUT the restoration refused likewise, RED against the resolver-keyed arm, which commits both and leaves the decision unrecoverable in `change` with no open request for a re-approval to resolve; the REOPEN arm — `status` set back to `'open'` on a closed row — refused, so the reopen-then-reclose sequence that would carry already-non-NULL resolver columns past a transition-keyed arm is unrepresentable, and the reopen refused too while another open request exists for that decision; the DELETE arm — a `DELETE` of an OPEN and of a CLOSED `ChangeRequest` row each refused, the seed's `changeRequest.deleteMany()` succeeding inside its named disable with the seal enabled afterwards, and no cascade arm exercised because a project holding a change request holds `DomainEvent` rows and its hard delete is refused at the tenant FK; the INSERT arm's closed-row half — a row inserted already `withdrawn` or `resolved` REFUSED, with a complete truthful closure set and a completed receipt exactly as much as without one, and the decision left untouched (#572's review round 13, finding 1 — RED against round 12's admitting arm, which commits the fully-provisioned row and leaves permanent evidence of a request and a closure that never occurred); and the PRECISION half, which is what proves the re-key demands nothing new of the delivered writers: the SHIPPED `decisions.approve` from `change` and the SHIPPED `decisions.withdrawChange` both driven after the trailing seals and COMMITTING unchanged, their single `updateMany` carrying `status`, `resolution`, `resolvedById` and `resolvedAt` together exactly as `decisions.service.ts:492` and `:919` write them today; the SHIPPED `decisions.requestChange` driven THROUGH the service after the trailing seals in BOTH key shapes — with an `Idempotency-Key` and with NO header at all under the documented default (`COMMAND_KEY_ENFORCED` unset) — each COMMITTING with a non-NULL `sourceCommandId` (the client's key, or the synthesized server key) and a non-NULL frozen `requestedByRole`/`requestedByName` pair, so the seals are proven PRECISE and not merely strict: RED against the unsynthesized writer on the no-header arm and against the pair-less writer on both (#572's review round 1, findings 1 and 2 — the arm above tested only that legacy-shaped rows are refused, which a writer that cannot satisfy the seal also passes); a decision notification without `eventId` or without `kind` refused while legacy rows survive; a new `DecisionApprovalRevision` without `approvedByName` or `approvedByRole` refused while the legacy NULL rows survive (a receipt-backed no-chain approval after the drain cannot lose its attribution); the retired catalog version's intent refused; **P42b** with P31b (§B.4); the five live previous-release decision writers — the no-chain approve, the standard `requestChange`, `withdrawChange`, `requestConsultation` and `respondToConsultation` — each driven as its exact 4c-shaped bundle (a NULL envelope pair, no `sourceCommandId` and no notice on the standard request, `dispatch: {}` where the delivered emitter sends nothing, the delivered targeted shapes on the consultation events) through the 4d-i seals and asserted to COMMIT, then after 4d-iii refused exactly where a trailing seal requires what the shape lacks (RED against a NULL rule admitting the approve alone); the drain-window interleaving — a `Project` INSERT and an owner/admin `OrgMembership` INSERT under the barrier in both orderings during the 4d-i → 4d-iii window leaving no `pmc` row, 4d-iii's re-projection restoring it behind the table fence before any door installs, that repair issued under `vitan.phase6_4d_standing_reprojection` and the SAME repair statements refused both WITHOUT the gate and with the gate but without the fence (#572's review round 5, finding 4 — RED against an ungated repair, which the writer-depth seal refuses, and proving the gate narrow rather than merely present), and a direct-SQL `Project` + owner/admin `OrgMembership` pair started AFTER the fence observed BLOCKED in `pg_stat_activity`, the migration committing its repair and its doors, the pair then meeting the doors — exactly ONE commits, the other is REFUSED by its door's message, the refused statement RETRIED after the winner commits succeeds, the terminal state holds the `pmc` row, both resume orders (the pair started BEFORE the fence delays the fence until it ends and IS repaired); 4d-iii over a `decisions.effects` an operator activated then deactivated — the retirement re-activating at the next sequence and verifying the head, a retirement whose verification fails leaving every door installed, a replay over an active head appending nothing | `DecisionApprovalRevision_provenance_target_key` widened + the two spec FKs re-targeted; the trailing seals |

## §D — Staging, review unit, and order

- **This plan unit** is docs-only: this document and the STATUS record it
  owes, folded in the same PR under `CLAUDE.md`'s rule that an autonomous
  `claude/**` draft names itself (`task_state: in_progress`, `open_pr` this
  PR's number on the pointer commit; `none` on the unit commit, because the
  number does not exist until the PR is created — the §D self-naming
  convention every 4c and 4d unit followed). `reviewed_merge` stays
  `f5da6654` (the last REVIEWED merge; #536 was a STATUS record),
  `next_task` stays `phase-6-task-4d` (the id names the task stop; this
  narrative binds what starts at it — 4d-i, only after this plan clears),
  `phase_plan` NAMES THIS PLAN — corrected in round 22 off
  `2026-08-29-decision-workflow-4c.md`, which is complete and merged, and
  already committed that way in the Now block above (#572's review round 25,
  finding 2: this paragraph still instructed a handoff to keep the pointer on
  4c "until this plan CLEARS", which would either restore a finished plan as the
  runner's active source or move a pointer that has already moved). The
  authoritative statement is the Now block; this narrative describes it and
  never contradicts it. Runner invariants over the parsed
  Now block: `assessRunnerState` → `pr:<this>` while open;
  `assessPostMergeRunnerState` → simulated, allowed, `task:4`;
  `detectStatusDrift` with the self-named `open_pr` live → no drift. It
  clears by a fresh clean +1 through the `codex-current-head` gate — the
  independent clearance the 4c plan's #486/#490 detour restored as a
  precondition — and 4d implementation begins only after that merge, from
  the `main` that carries it. Further findings on this PR are folded on
  THIS branch, whatever the head count: the forced close-and-replace at the
  second finding-bearing head was retired on `main` by #578 (`f050bcd`),
  and the Board's decision for this unit is fix-forward (#482 comment
  5585712971). A replacement is opened only for a concrete change of scope
  or approach, recorded with a `Replacement reason:` beside `Replaces: #N`
  and carrying every outstanding finding and proof — never to reset a
  count (#572's review round 3, finding 1).

- **4d implementation follows as SIX PRs — the dark migration 4d-i, the
  PAIRING SWITCH-ON 4d-i-b, the
  dark SERVER unit 4d-ii-a, the CLIENT unit 4d-ii-b, a drain attestation,
  and the trailing reservation retirement 4d-iii — each honouring the
  mandatory migration seam and the service/UI seam the standing reservation
  makes viable** (#567's review round 1, finding 4; "4d-ii" names the pair
  wherever the distinction does not matter; 4d-i-b was carved out of 4d-i on
  JagPat's instruction during #582's review round 6 — see the bullet below) (the additive schema is deployable before any caller uses it — that
  viable seam makes a single migration+service+UI PR a violation of the
  repository's migration review-unit rule, and this plan takes the seam):

  - **4d-i, the migration unit — MIGRATION-ONLY in the template's sense**:
    its diff touches `prisma/` (the two migration files, the schema mirror, the
    seed's reset protocol), `test/` (the fixtures, the resets, the tripwires
    and the probes the seals force), `scripts/` (the proofs' named plant
    bypass) and, under `src/`, EXACTLY the declarative schema-metadata
    mirrors the tripwire suites pin to the Prisma DMMF — the
    `decisionsManifest`/`orgsManifest`/`platformManifest` `ownsModels` and
    `readEncapsulated` registrations of the new tables and the `MODEL_OWNER`
    entries (#556's review round 2, finding 5: the boundary suite requires
    each manifest's model set to EQUAL the DMMF, so a migration that adds a
    table cannot merge without its registration, and a rule that said "no
    `src/` file" contradicted itself); no service, controller, query,
    emitter, participant or UI change — every application change —
    `emitEvent`'s envelope write, the widened `EventActor`, the full
    `AttributionActor`, the orgs identity contract, the TypeScript kernel
    queries, the commands — is 4d-ii's (#556's review round 1, finding 3: the
    dark, nullable columns need none of it to deploy safely, and carrying it
    here would erase the migration/service seam the review protocol
    requires). 4d-i declares `<!-- migration-scope: inseparable -->` with
    exactly that boundary stated in its `Migration/service seam` line, and
    its packet lists every `src/` path it touches with the registry line each
    adds — the reviewable proof that nothing else moved; any other `src/`
    path in its diff is a scope finding.

    **TWO additive migration files, applied in order** (JagPat's instruction
    during #582's review round 13: *split #582 at the seam you proposed*, after
    the lifecycle reported twelve finding-bearing heads against a limit of five
    and asked for a split six times). The seam is a DEPENDENCY DIRECTION, not a
    line count: the four adopted platform registers — with their baseline
    audits and their writers — separate cleanly from the decisions fact tables
    and their pairing seals, with no dependency in that direction. The
    registers do not read a fact table; the fact seals read the registers. So:

    | order | migration | carries |
    |---|---|---|
    | 1 | `20271220000000_phase6_t4d_i_dark_migration` | Part 0's retirement marker and its seals, the shared refusal function and the two orgs-owned architect-STANDING doors with their diagnostic-first audits, the four adopted platform registers (`ProjectOrg`, `ProjectRoleStanding`, `ProjectUserStanding`, `UserIdentity`) with their writers, backfills and baseline audits, `OrgUserAuthority`, the orgs-owned `MembershipTransition` fact and the membership seals around it, `ExternalEffectCatalog` with both seeded coverage generations, `ReleaseLease`, the generic pairing mechanism (`DomainEventPairingClaim`, `platform_claim_event_pairing`, `DomainEvent_t4d_pairing_claimed`), and the WHOLE KERNEL — the envelope columns and `DomainEvent_t4d_envelope`, the five `ProjectEventStream_t4d_*` allocation seals, the notice binding, and the `platform_tx_*` / `platform_role_*` reads |
    | 2 | `20271221000000_phase6_t4d_i_decision_facts` | the two Decision CHAIN doors, Part 2's enum values, the three decisions-owned fact tables with their seven obligations (`DecisionForward_t4d_reserved` among them), the 4d-only columns added to `ChangeRequest`, `DecisionApprovalRevision`, the two consultation tables and the two requirement-spec tables with their legacy-shape audit, the `DecisionEvent` audit register's append-only and correspondence seals, the delivered 4b/4c seals widened with their architect arms, and the approval finality key |

    THE DOORS SPLIT WITH THEIR SUBJECT, which is why the reservation is not
    torn in half: `phase6_t4d_reserved()` and the two doors that reserve
    architect STANDING go with the registers that record standing; the three
    doors that reserve the Decision CHAIN go with the facts the chain writes.
    Part 2's enum values are the chain's vocabulary and go with it — the file's
    own note already records why that is not a coupling (*nothing in THIS
    transaction consumes either value — every comparison above and below is
    made on `::text`*).

    AND THE KERNEL IS NOT DIVIDED. The envelope seal, the five
    `ProjectEventStream_t4d_*` allocation seals, the notice binding and the
    generic pairing mechanism are platform-owned, so they are all in the first
    file: a platform-owned seal in a file named for the decisions facts would be
    a module-ownership defect whatever the line count. (The first partition put
    the allocation seals on the decisions side — a section label trusted instead
    of the file read — and they were moved before anything was pushed. The
    `DecisionEvent` register's seals stay in the second file because that
    register is decisions-owned and its correspondence reads the facts.)

    The measured proof of the seam belongs in the packet, and it is a
    measurement of the FILES rather than of the partition's section labels:

    · **81 functions**, 52 defined in the first file and 29 in the second, with
      no name defined twice. (Round 17 added two: `phase6_t4d_actor_pair_true`
      in the first file, where the shared correspondence was factored out of
      `phase6_t4d_actor_bound` so the kernel envelope can call it without the
      fact-side preconditions, and `phase6_t4d_change_request_birth_pair` in the
      second.)
    · **The first file calls NOTHING the second defines** — the dependency is
      one-way. The second calls **eleven** functions the first defines:
      `phase6_t4d_reserved`, `phase6_t4d_retired_at_start`,
      `phase6_t4d_fact_no_truncate`, `phase6_t4d_actor_bound`,
      `platform_claim_event_pairing`, `platform_membership_active_user`,
      `platform_role_has_holder`, `platform_role_standing`,
      `platform_tx_event`, `platform_tx_event_count` and
      `platform_user_holds_role`.

      **This said TWELVE, and the twelfth was never a call.**
      `phase6_t4d_membership_transition_bound` appears in the second file in a
      COMMENT and nowhere else. The figure came from counting NAME OCCURRENCES
      rather than call sites — the same method-versus-object slip rounds 13 and
      15 recorded in other forms, in a paragraph that presents itself as a
      measurement. It is re-measured here with comments stripped and on word
      boundaries, which is also how the count above is now taken.
    · **No statement in the first file names a decisions fact table.** The two
      occurrences of those names in it are both explanatory comments — one
      naming a door the second file installs, one naming the pairing collision
      the per-branch claimant rule avoids.
    · **The first file APPLIES STANDALONE** to a fresh database, the pair
      applies in order, and BOTH are re-runnable against an already-migrated
      database — which is what `ALWAYS_EXECUTE`'s baseline replay rests on, and
      is measured rather than assumed. `20271221000000` is a later migration in the ordinary
    Prisma sense, so it is deployed, recorded, resolved and rolled back
    SEPARATELY — `migrate.sh` reads the failed name out of Prisma's output and
    §P6T4D's recovery names the half that failed, because resolving the other
    leaves the real failure recorded.

    AND NO WINDOW OPENS BETWEEN THE TWO COMMITS. Between the first file's
    commit and the second's, the chain doors do not yet exist — and neither
    does the vocabulary they reserve: `DeciderKind.architect` and
    `DecisionStatus.awaiting_countersign` are enum values the SECOND file adds,
    after it has created the doors. Both columns are enum-typed, so in that
    window no writer can name either value at all; the doors are created first
    and the values second, inside one transaction, so the reservation is in
    force from the instant the vocabulary exists. That ordering is the reason
    Part 2 travels with Part 1's chain doors rather than staying behind.

    **THE RESERVED SET IS EVERY SHAPE WHOSE FIRST SANCTIONED WRITER IS 4d-ii**,
    and it is stated as ONE enumeration because stating it as several is how a
    member goes missing (#582's review round 15, findings 2 and 3, which are
    the same omission at two ends). It has three kinds of member and each gets
    the instrument that fits it:

    · **STATES and ROLES** — `Decision.deciderKind = architect`,
      `Decision.status = awaiting_countersign`, `Membership.role = architect`,
      `User.role = architect` — reserved by a runtime DOOR.
    · **The forward FACT** — a `DecisionForward` row — reserved by a door too.
    · **The audit register's 4d-only KINDS** — `countersigned`,
      `stranded_resolved`, `forwarded`, `countersign_renotified` — reserved by
      `DecisionEvent_t4d_kind_reserved`, the SIXTH door, through the same
      `phase6_t4d_reserved` function and the same WHEN-clause shape. Round 15
      found these writable for the whole dark window: the weak correspondence's
      table has no entry for (`countersigned`, `pending`) at all, so it returned
      without judging, and on an `approved` decision the no-chain approval's own
      `decision.approved` event answered the row's requirement. Either way the
      row committed, the append-only seal froze it, and 4d-iii's stronger
      INSERT trigger judges only NEW rows — permanent evidence of a countersign
      nobody performed. Widening the weak body was the wrong instrument: it
      would carry a copy of 4d-iii's converse in this file, and it would still
      ADMIT a kind whose command does not exist.
    · **DARK TABLES** — `DecisionForward`, `DecisionCountersign`,
      `DecisionStrandedResolution`, `MembershipTransition`,
      `DomainEventPairingClaim` and `ReleaseLease` — reserved by an APPLY-TIME
      emptiness audit, gated on the retirement snapshot, each half auditing the
      tables it creates. `ReleaseLease` is the one round 9's sweep missed and
      the one with the worst failure: its seals refuse DELETE and refuse any
      `leaseUntil` decrease, so an adopted pre-baseline row can never be removed
      or shortened and 4d-iii's drain preflight reads it as a still-serving
      previous release forever — the drain never attests and the reservation
      never retires.

    **AND 4d-i's DEPLOY CARRIES THE EXTERNAL-EFFECT RESEAL** (#582's review
    round 15, finding 1). 4d-i MOVES `effectCoverageVersion()` — rounds 13 and
    18 split four keys in two, so the catalog gains `activity.created.init`,
    `decision.published.record`, `inspection.created.init` and
    `inspection.approved.closing` — and `OutboxBootstrap` THROWS at startup when the
    compiled hash differs from the persisted `OutboxCutoverState`. Seeding both
    catalog generations answers the DRAIN dimension of that change and leaves
    the CUTOVER-SEAL dimension untouched, so an instance running
    `OUTBOX_SENDER_MODE=outbox` refuses to boot after this upgrade. P38 already
    carries the arm for the next unit — *the 4d-ii build refused in outbox mode
    under the 4d-i seal* — which is the same mechanism one stage later; nothing
    covered the 4d-i build under the PRE-4d-i seal.

    So 4d-i takes the SAME sequence 4d-ii takes, and §P6T4D states it: deploy in
    `legacy` or `shadow`, run `outbox:seal-external` to record the new coverage,
    then restart in `outbox`. Keeping 4d-i hash-neutral is not available at all
    after round 18: the added keys ARE the hash change, and they are the fix for
    three P1s. (The earlier form of this paragraph offered backing `pushOptional`
    out of the preimage as the rejected alternative. Round 18 removed the flag
    entirely, which does back it out of the preimage — and does NOT re-open the
    hole round 5 closed, because the thing two catalogs could disagree about no
    longer exists.)

    **AND THE OUTGOING GENERATION IS NO LONGER A POLICY-IDENTICAL COPY.** Those
    four keys are the exact set where this release and the previous one mean
    different things: the previous release admits a silent event at
    `activity.created`, `decision.published`, `inspection.created` and
    `inspection.approved`, and this one does not. The migration therefore seeds
    the outgoing generation with `requiresPush = FALSE` at those four and
    without the four added keys — declared in one place in the seed and
    re-derived by `phase6-t4d-i-catalog-generations.test.ts`. Copying this
    release's obligation into the outgoing generation would refuse every record
    publication, participant checklist initialisation and closing approval a
    still-serving process emits, for the whole drain.

    Within the pair the ordering below is otherwise unchanged.
    **Part 0, the
    marker transaction** (#572's review round 25, finding 4 — correcting round
    23's own fix): `RolloutRetirement(unit TEXT PRIMARY KEY, retiredAt,
    retiredBy)` with its seals, created and COMMITTED FIRST, because every
    marker-aware statement in this file reads it — the transient reservation
    block of Part 1 included — and on a fresh database the relation does not yet
    exist when Part 1 runs. Round 23 made Part 1 marker-aware and left the table
    in Part 3, so a fresh install would abort on a missing relation while
    dropping the query would restore the mature-replay downgrade the marker was
    introduced to prevent. The table is permanent and unconditional, so it
    belongs before every conditional thing that consults it; Part 3's inventory
    below no longer creates it. **Part 1, the doors transaction**:
    the shared refusal function `phase6_t4d_reserved()` and the two
    TEXT-judged `Decision` doors (`Decision_t4d_architect_reserved`,
    `Decision_t4d_awaiting_reserved`), committed FIRST. **Part 2, the enum
    statements**: `ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS
    'architect'` and `ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS
    'awaiting_countersign'`, each its own statement (a value added inside a
    transaction is unusable until it commits — the way 20271015 added
    `recorded`). **Part 3, the seal-and-audit transaction**, opening with
    BOTH orgs-owned RESERVATIONS — the `Membership` door's `CREATE TRIGGER`
    (`Membership_t4d_architect_reserved`, taking ACCESS EXCLUSIVE on
    `Membership`) and `LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE` with
    the `User` door's `CREATE TRIGGER` (`User_t4d_architect_reserved`) — and
    only after BOTH locks are held (#558's review round 2, finding 9) the
    diagnostic-first `Membership` and `User` audits that ABORT with a bounded
    sample, then everything else:
    the THREE decisions-owned fact tables (`DecisionForward`,
    `DecisionCountersign`, `DecisionStrandedResolution`), each registered in
    `decisionsManifest.ownsModels` AND `readEncapsulated`, with composite
    same-project FKs, candidate keys, CHECKs (`btrim` non-blank over the
    complete ASCII whitespace set, the `outcome` and designation-kind
    discriminators), the seven contract obligations' seals — append-only +
    named no-TRUNCATE, the deferred pairing triggers in both directions,
    actor-standing (the frozen role and name judged) and subject-eligibility
    reads through the delivered primitives under `phase6_try_readiness`,
    the 4c provenance shape reusing `phase6_t4c_provenance_bound` where a
    command writes one fact and the 4d-owned bundle-aware
    `phase6_t4d_provenance_bound` where it writes a bundle, and the
    effect-correspondence checks through the NEW platform-owned
    `platform_tx_event` (attribution, frozen name, named payload fields and
    the frozen-audience push shape included); the platform-owned
    `DomainEvent_t4d_envelope` seal, the platform-owned
    `ProjectEventStream_t4d_allocation` seal with its deferred one-to-one
    allocation pairing, the platform-owned `Notification_t4d_binding` seal
    and the platform-owned, gate-written `ExternalEffectCatalog` seeded with
    the current compiled catalog as literal SQL under its tripwire, with
    `ExternalEffectCatalog_t4d_no_truncate` (§A.3 obligation 7); the
    decisions-owned `DecisionEvent_t4d_append_only` seal and, beside it, the
    decisions-owned DEFERRED `DecisionEvent_t4d_correspondence` constraint
    trigger carrying the WEAK converse — the (kind, committed status) table §A.3
    closes — installed MARKER-AWARE, so a replay over a retired database gets the
    full 4d-iii body instead (**self-found while tracing round 23's two findings
    through their installers**: round 21 introduced this trigger in §A and named
    it in 4d-iii's replace, and this staged list — the one an implementation
    follows — never gained the CREATE, which is *a contract that names no
    installer is not installed* on the plan's own material for the fourth time);
    `Notification.kind`
    beside `Notification.eventId`; the four nullable, frozen
    consultation attribution columns — `DecisionConsultation.requestedByRole`/
    `requestedByName` and `DecisionConsultationResponse.respondedByRole`/
    `respondedByName` — with their DMMF-pinned schema metadata (#562's
    review round 2, finding 4: the inventory named one of the four); the
    kernel read `platform_event`
    (the `DomainEvent_t4d_deliveries` seal and the rule columns moved to
    4d-ii, beside the migration that writes the rules and the emitter that
    writes the rows — #560's review round 1, finding 6), the
    `ReleaseLease` table with its identity freeze, no-DELETE and no-TRUNCATE
    seals (dark until 4d-ii writes it), the
    same-decision INSERT binding — which is `Notification_t4d_binding_bound`,
    the DEFERRED constraint trigger, NOT the immediate `Notification_t4d_binding`
    freeze §A names two lines above in this same list (#572's review round 5,
    finding 1: round 4 split the two objects in §A and this manifest went on
    assigning the INSERT arm to the freeze, so following it would recreate
    the trigger PostgreSQL cannot make or drop the binding altogether) — the decisions-owned
    `ChangeRequest` closure↔restoration trigger and the
    `countersign_renotified` partial unique; the platform-owned `ProjectRoleStanding` register
    with its writer-depth seal, its project-cascade arm, the orgs-owned
    `Project_t4d_deleting` flag trigger and `ProjectRoleStanding_t4d_no_truncate`,
    **the platform-owned `ProjectOrg(projectId PRIMARY KEY, orgId)` register in
    FULL — the table, the generic platform primitive that writes it, the
    orgs-owned `Project` AFTER INSERT trigger that calls it from its own row,
    the backfill from `Project` under the same `SET LOCAL` gate as the other
    registers, the writer-depth seal (a depth-1 write refused, the nested
    standing-trigger write admitted), the project-cascade arm (depth +
    `Project_t4d_deleting`), the IMMUTABLE `orgId` (any UPDATE refused), the
    `platform:verify` offline comparison against `Project`, and its
    `ProjectOrg_t4d_no_truncate` seal** (#572's review round 15, finding 1:
    round 14 added this register to §A, where
    `platform_user_orchestration_authority` and every race-free arm now depend
    on it, and did not add a single one of those artifacts to this closed
    inventory — so an implementation following the stages would reach the
    4d-iii switch with the derivation's project-to-org source absent and every
    membership-less PMC action failing, which is precisely the defect round 14
    named ROOT CAUSE ONE and then committed on its own fix),
    backfilled to one `architect` row per project at zero;
    `Membership_t4d_no_truncate`; the orgs-owned `MembershipTransition` fact
    (registered in `orgsManifest.ownsModels`/`readEncapsulated`) with its
    frozen `actorRole`/`actorName` pair, its
    deferred membership FK, its receipt FK, its one-use UNIQUE, its
    append-only seal WITH its project-cascade arm (depth + `Project_t4d_deleting`,
    #572's review round 12, finding 5) and `MembershipTransition_t4d_no_truncate`, the
    `phase6_t4d_membership_transition_bound` binding, the actor-authority
    BEFORE INSERT trigger, and the PERMANENT orgs-owned
    `Membership_t4d_architect_provenance` pairing seal with its event
    correspondence; the ORGS-owned `Membership_t4d_role_standing` trigger, BEFORE ROW so
    the delivered AFTER holder guard judges the post-write count (#565's
    review round 2, finding 1), writing through the generic platform
    primitive `platform_role_standing_apply`; the kernel reads
    `platform_role_holder_user_ids` and `platform_membership_active_user`
    over the per-user register; the platform-owned
    `platform_tx_notification`; the nullable `DomainEvent.actorRole` and
    `actorName` envelope columns under the delivered append-only trigger —
    DARK, written by nothing until 4d-ii; `ExternalEffectCatalog.retiredAt`
    with its gated one-way stamp and the seed's `ON CONFLICT DO NOTHING`; the platform-owned
    generic pairing mechanism — the `DomainEventPairingClaim` register with
    its writer-depth, append-only and no-TRUNCATE seals, the
    `platform_claim_event_pairing` primitive, the catalog's
    `pairingRequired` column seeded under the tripwire — `false` on EVERY
    row, so 4d-i installs the mechanism and switches it on for nothing (the
    flip and the remaining claimants are 4d-i-b's; see that bullet) — and the
    kernel-owned
    `DomainEvent_t4d_pairing_claimed` seal — with the claim supplied per
    BRANCH by that branch's PRIMARY fact seal and every other fact in the
    bundle verification-only, exactly as §A states it, and no peer-owned
    trigger on the kernel table (#568's review round 1, finding 2). The
    blanket "every fact seal claims its events" this manifest used to carry
    is the shape §A retired in round 4, and it aborts a VALID bundle: a
    returned resolution's `DecisionStrandedResolution` and `ChangeRequest`
    share `decision.change_requested`, so two seals would claim one event and
    meet the register's per-event UNIQUE — the same collision between a
    reapproval revision and its closing request (#572's review round 5,
    finding 2); the reset protocol in
    `prisma/seed.ts` and `test/integration/fixtures.ts` gaining
    `DecisionEvent_t4d_append_only` and `DecisionEvent_t4d_correspondence`
    (§A.3's "one new name", stated there and owed here), the pairing-claim register's seals (the
    claims truncated with `DomainEvent`), the membership path (transition facts,
    then memberships, under their seals disabled by name), the three NEW
    fact tables — `DecisionStrandedResolution`, `DecisionCountersign`,
    `DecisionForward`, deleted child-first before their `Decision` under
    their row seals disabled by name for that reset only (#561's review
    round 2, finding 9: a restrictive fact FK would block the parent's
    deletion and a cascading one would meet the fact's DELETE seal, so a
    P34/P31/P29b scenario's decision could never be torn down), the
    `Notification`/`ChangeRequest` path (#558's review round 2, finding 8:
    kinded feed rows are undeletable behind the FK to `DomainEvent` and
    `ChangeRequest` rows are delete-sealed, while the seed truncates
    `DomainEvent` alone and deletes both tables directly, as do many suites)
    — `Notification_t4d_no_truncate` in `TRUNCATE_SEALS`, the sanctioned
    reset truncating `DomainEvent` TOGETHER WITH `Notification` AND
    `DomainEventPairingClaim` under the named disables, and every `notification.deleteMany` /
    `changeRequest.deleteMany` cleanup routed through the named
    `wipeNotifications` / `wipeChangeRequests` helpers — and the sweep of
    EVERY `DecisionEvent`, `Notification` and `ChangeRequest` UPDATE/DELETE
    site — hand-disabled and unguarded — into the helpers, the three
    precision arms rewritten, with the statement-enumerating tripwire
    covering all three tables; the `insertRawEvent` fixture, the named
    legacy-plant bypass in the proofs and the raw-insert tripwire; the
    `DomainEvent(projectId, eventId)` candidate key and
    `Notification.eventId` (nullable, same-project composite FK to it,
    partial UNIQUE); `DecisionApprovalRevision.finalized`
    (DEFAULT `true`, KEPT) with the birth seal, the widened candidate key and
    the backfill, the delivered `DecisionApprovalRevision_append_only`
    trigger DROPPED and replaced by the one-flip seal, and the immutable
    `approvedFrom`, `approvedByName` and `approvedByRole` (nullable for
    legacy and drain-window rows, required on any revision born `false`);
    `revisionFinalized` on the two spec tables (DEFAULT `true`, KEPT) with
    the CHECK, the backfill and the FK re-target; `ChangeRequest.projectId`
    (backfilled, trigger-filled for old writers, `NOT NULL`,
    composite-FK-bound to `Decision(projectId, id)`), `ChangeRequest.origin`
    and `revisionId` with their backfills and CHECKs, the frozen
    `requestedByRole`/`requestedByName` pair, the extended freeze, the
    nullable `sourceCommandId` with its composite FK and partial one-use
    UNIQUE, the `ChangeRequest_t4d_no_truncate` seal (a statement trigger
    fires on an empty table, and the harness's `TRUNCATE "Decision" …
    CASCADE` reaches `ChangeRequest`), and the two-producer P33b pairing
    — EXCEPT `ChangeRequest_t4d_paired` itself, which 4d-i-b installs (see
    that bullet; the column, the CHECKs, the FK, the one-use UNIQUE and the
    freeze all stay here, so 4d-i-b adds a seal over data 4d-i already
    shaped); the
    two platform-owned per-user registers `ProjectUserStanding` and
    `UserIdentity` with their writer-depth and no-TRUNCATE seals, their
    gated backfills and the orgs-owned triggers that feed them, and the
    three platform kernel reads `platform_user_orchestration_authority`,
    `platform_user_holds_role` and `platform_user_display_name` (no
    decisions seal invokes an orgs-owned function — #561's review round 1,
    finding 1); `phase6_t4b2_decision_seal` and the holder-orphan audit
    with their SEPARATE architect arms over `platform_role_standing`, the
    delivered `client`/`pmc` arms untouched (#565's review round 1,
    finding 1),
    the forward door opened in `decision_t4b_attribution_seal` (status-gated,
    target- and actor-judged) with its two approval clauses widened for the
    sealed provisional transition (#567's review round 2, finding 3), and
    the approved-entry seal with its decision-side `awaiting_countersign`
    entry arm AND its born-awaiting INSERT refusal (#567's review round 2,
    finding 2); the
    `phase6_t4b2_membership_guard` open set widened with its one named
    exemption; the two 4c consultation seals `CREATE OR REPLACE`d with the
    `awaiting_countersign` arm ONLY — the requester arm stays on
    `phase6_user_decision_authority` (byte-identical) until 4d-iii re-points
    it after the fenced re-projection (the window rule of §A.2, #566's
    review round 2, finding 1); and the remaining reservation door
    `DecisionForward_t4d_reserved`. **The TRANSIENT portion is a NO-OP once 4d
    has retired**: in `ALWAYS_EXECUTE` a later P3005 baseline of a MATURE
    database — one holding a legitimate active architect after 4d-iii —
    replays 4d-i before 4d-iii, and an unconditional file would re-create
    the reservation and ABORT on that valid row. 4d-i therefore SPLITS its
    body: the PERMANENT guards (tables, columns, seals, backfills,
    primitives, the register) run unconditionally and re-runnably, while the
    TRANSIENT block — all FIVE reservation triggers, their SHARED refusal
    function and the audit — runs only when the durable RETIREMENT MARKER is
    absent.

    **"Unconditionally and re-runnably" is not the same as MONOTONIC, and every
    `CREATE OR REPLACE` in the permanent portion whose body a LATER unit
    replaces must be marker-aware** (#572's review round 16, finding 2). The
    instance is the consultation request seal: 4d-i replaces its function to
    widen the open set while KEEPING the delivered
    `phase6_user_decision_authority` requester arm (the window rule), and
    4d-iii replaces it again to re-point that arm onto
    `platform_user_orchestration_authority` after the fenced re-projection. On a
    fresh install and an ordinary upgrade that order is correct. On a P3005
    BASELINE REPLAY over a MATURE, already-retired database — the case
    `ALWAYS_EXECUTE` exists for — 4d-i runs again and its unconditional replace
    DOWNGRADES the live seal to the pre-4d-iii body, and the corrected arm does
    not come back until the later 4d-iii migration reaches its own re-point. The
    gap is not instantaneous: 4d-iii's transaction acquires the table fence and
    performs the re-projection first, so a deploy that stalls or fails there
    leaves the 4d-i transaction COMMITTED and every serving instance refusing
    every architect consultation request until someone recovers it. So each such
    statement reads the SAME `RolloutRetirement` marker the transient block
    reads, and installs the POST-retirement body when the marker is present —
    the replace becomes monotonic rather than merely idempotent. The marker is
    already the mechanism 4d-i uses to decide it must install no reservation
    door on a replayed mature database (#560's review round 2, finding 5's
    sibling); this finding is that the same question was asked of the DOORS and
    not of the function bodies beside them.

    **The marker-aware set holds TWO statements, and the rule that keeps it
    complete is stated here rather than left to a sweep that ages**
    (#572's review round 23, finding 2). Round 16 swept 4d-i's permanent portion,
    found the consultation seal plus the participant's
    `effectiveRoleHolderUserIds` wrapper — which is switched by
    `rollout.phase6_4d` reading `open` rather than by a replace, and is therefore
    already monotonic — and wrote "and no others". That was true when it ran and
    became FALSE five rounds later, when round 21 gave 4d-i
    `DecisionEvent_t4d_correspondence` with the WEAK body and 4d-iii a replace
    with the FULL converse: exactly the shape this paragraph quantifies over,
    added without re-deriving the sentence that counted it. On a P3005 baseline
    replay of a mature post-4d-iii database an unconditional create DOWNGRADES
    the live seal to the weak body, and an audit row carrying the right event
    type but NO fact and NO transition commits and becomes immutable history
    until 4d-iii's own replace runs — which, if the deploy stalls or fails, it
    does not. So `DecisionEvent_t4d_correspondence` joins the consultation seal:
    4d-i's create reads the SAME `RolloutRetirement` marker and installs the
    POST-retirement body — the full fact-and-transition converse — when the
    marker is present, the weak body only when it is absent.

    **And the marker's VERDICT is taken once, before 4d-i creates any of the
    evidence that verdict reads** (#582's review round 7, finding 1). Round 5
    hardened `phase6_t4d_retired()` against a FORGED marker — a
    `RolloutRetirement` row for `phase6-4d` on a database that never ran 4d-iii,
    which a `db push` baseline can carry — by requiring one of 4d-i's own
    artifacts beside it. That artifact is created BY 4d-i, so the predicate was
    correctly false at the doors and turned TRUE a few thousand lines later, the
    moment the seal function existed: every marker-aware gate after that point
    skipped as though retirement had happened, and the unit committed with
    `DecisionForward_t4d_reserved` uninstalled and `DecisionEvent_t4d_correspondence`
    absent — a database calling itself dark with the forwarding door open. A
    predicate may not be evidence of a state its own file is midway through
    creating. So 4d-i takes the verdict in a transaction-local snapshot
    immediately after defining the predicate and before Part 1, and every gate in
    the file reads `phase6_t4d_retired_at_start()`; `phase6_t4d_retired()` remains
    the durable definition of "retired", which is what the snapshot calls and what
    a later unit asks of a settled database. Any marker-aware statement added to
    this file joins the snapshot, never the live predicate.

    **And the sweep is replaced by an OBLIGATION, because a count is a fact about
    one moment and this one has now aged into a false claim once.** Any statement
    added to 4d-i's permanent portion whose body a later unit replaces joins the
    marker-aware set IN THE SAME EDIT, and this paragraph's enumeration is
    re-derived there — the standing form of *a completeness claim is re-run, not
    inherited*, which this plan family has now recorded three times (this
    finding; the companion document's round 4 findings 1 and 3). The set today is
    the consultation request seal and `DecisionEvent_t4d_correspondence`, plus the
    wrapper that needs no marker.

    **ROUND 8 — the four corrections that follow from one sentence: a seal must
    ask a question its writer cannot answer at will** (#582's review round 8,
    findings 1/2/4, 5, 6, 7 and 8).

    *Fact-first is enforced from the FACT's side, and the self arm is gone.*
    Round 6 made "the fact precedes the membership write" a sealed protocol, and
    switched it on from the membership side by asking whether a member-command
    receipt existed in the transaction. A writer chooses when its receipt
    exists: membership first with no receipt, then reserve and complete it, then
    the fact — and every deferred check passes at commit while the fact's live
    authority read has seen the standing the write GRANTED. So the ordering is
    enforced where it is a fact rather than a signal: at the fact's INSERT the
    membership row must not already carry this transaction's `xmin`, the system
    column no writer sets. An ADD is unaffected (its membership does not exist
    yet, which is why the FK is deferred). With that in place line 560's
    consequence is finally true, and the seal takes it: **the self-demotion arm
    is REMOVED, not narrowed.** It admitted any transition whose subject was its
    actor and whose direction was loss, so a contractor or engineer with no
    authority could remove themselves — while the shipped `MembersService.remove`
    refuses self-removal outright and P29b requires "a contractor's
    self-transition refused". The exception existed for a live-read hazard that
    fact-first dissolves: an authorized actor still holds their standing at the
    moment the fact is written.

    *Birth provenance and resolver provenance are two rules.* A single
    `OLD.<col> IS NOT NULL` guard over all six `ChangeRequest` evidence columns
    admits NULL → value on every one. For the resolver set that IS the closure;
    for `sourceCommandId` and the requester pair it is a forgery route, and the
    same freeze then makes the fabrication permanent. The birth set is frozen
    against ANY update — a legacy row keeps its NULLs, a row that owes
    provenance supplies it at INSERT — and each attribution pair is pinned as a
    pair by CHECK (both halves or neither, and a present half non-blank).

    *Every adopted register is audited against its source, not merely for
    presence.* Round 7 asked this of `ProjectOrg` alone; `UserIdentity`,
    `OrgUserAuthority` and `ProjectUserStanding` had the same shape — a
    `db push`/P3005 baseline creates them before their seals exist, the
    backfills skip an existing key, and whatever is sitting there is adopted and
    frozen. Each is now audited: an identity that contradicts its `User`, an
    authority row with no owner/admin `OrgMembership` behind it, a standing row
    backed by neither an active membership in that role nor the membership-less
    `pmc` claim. AUDIT, NOT REPAIR — `platform_t4d_register_writer` admits only
    INSERT under the backfill gate, and correcting a row needs the
    re-projection gate that belongs to 4d-iii. 4d-i adopts or refuses. Judged on
    JUSTIFICATION only, never on `membershipId` equality, so a stale pointer
    beside a real membership does not abort a healthy database — the shape of
    round 6's zero-count defect, not repeated.

    *And the allocator's cascade exception needs the cascade* — see the rule row
    for finding 7 above. Raised at round 6 and not fixed until round 8; the arm
    that would have caught it now exists.

    **ROUND 9 — the same habit, one level up, and one reason of mine that was
    simply wrong** (#582's review round 9, findings 1-6).

    Round 8's corrections were each applied to the site reported and not to the
    CLASS, and round 9 is what that costs. The register audit was not extended to
    the dark FACT tables; the pair rule was not extended to the notice binding;
    the nonblank-string rule was not extended to the push TARGET; the audit
    exactness was left one-sided. So: the dark fact tables — `DecisionForward`,
    `DecisionCountersign`, `DecisionStrandedResolution`, `MembershipTransition`,
    `DomainEventPairingClaim` — must be EMPTY when 4d-i seals them, because 4d-ii
    is their first writer and before retirement the only correct population is
    none (gated on the retirement snapshot, so a mature replay aborts nothing);
    `(eventId IS NULL) = (kind IS NULL)` on `Notification`, because the only two
    compatible producers write both or neither and a half-bound notice is
    irreparable by construction; a present `targetUserId` must be a nonblank
    string; and the audit correspondence counts ROWS as well as events.

    **The catalog seed is restructured, and that is a regression this unit
    introduced.** Round 8's outgoing-generation copy read the REAL table, so a
    constraint-valid but wrong pre-baseline row — adopted by `ON CONFLICT DO
    NOTHING` — was propagated into a SECOND generation. The literal now lands in a
    temp table, the temp table is audited against whatever is already at those
    keys, the apply REFUSES on disagreement, and both generations are seeded from
    the literal. A definition changes by a new coverage version, never in place,
    so adoption was never the right verb.

    **And `ProjectUserStanding` binds `membershipId`, which round 8 got wrong IN
    WRITING.** Round 8 judged justification only and recorded the reason in the
    migration: "a stale pointer beside a real membership is untidy, not a grant".
    That is false. `membershipId` has exactly one consumer and it resolves the
    HOLDER by that column alone — `platform_membership_active_user` selects
    `userId` from the register `WHERE "membershipId" = p_membership`, with no join
    back to `Membership` — and its callers are the forward seal's current-holder
    read and its target-eligibility check. A row for user A carrying user B's
    `membershipId` hands a forward FROM B to A. Round 8 traced the TABLE's
    consumers and never the COLUMN's, and wrote the conclusion down as though it
    had. A documented wrong reason is worse than an undocumented gap, because the
    next reader trusts it; the correction is recorded at the audit itself.

    **ROUND 10 — one rule with four spellings, and a rule I put in the wrong
    place** (#582's review round 10, findings 1-5).

    The rule is: **a fact that records an act is COUNTED, not found.** Every
    deferred reverse-pairing seal asks "does a fact describing this write exist?",
    and every one of them is satisfied by any number of facts. The index that
    would have bounded the number does not: each of these tables is unique on a
    key that CARRIES the receipt — `DecisionForward_command_key` is
    `(projectId, sourceCommandId)`, `MembershipTransition_command_key` is
    `(projectId, membershipId, sourceCommandId)`, and a revision's key carries
    `version` — so two facts citing two receipts, or two revisions at consecutive
    versions, slip past the index and then past the existence test, which they
    satisfy SEPARATELY because each of them is individually truthful. The register
    is left holding two immutable, differently-attributed records of one act.

    Enumerated rather than patched three times: the pairing family is the forward,
    the countersign, the stranded resolution, the architect standing write and the
    revision birth. The countersign and the stranded resolution are already bounded
    — `DecisionCountersign_revision_key` and
    `DecisionStrandedResolution_revision_key` are keyed on the revision, not on the
    receipt — and the other three are exactly the three reported. So: the forward's
    reverse seal counts same-transaction forwards of its decision and demands ONE;
    the architect pairing counts the facts matching THIS write's `(user, fromRole,
    fromStatus, toRole, toStatus)` shape and demands one, which leaves a
    transaction that moves one membership twice free to record both moves; and a
    new deferred `DecisionApprovalRevision_t4d_birth_paired` demands one birth per
    decision per transaction and, on a PROVISIONAL birth alone, a decision this
    transaction actually wrote.

    **And the disagreement's demand moves to the transition, because round 8 put it
    on a state.** Round 8 made the forward's reverse seal demand an open
    `countersign_rejection` request whenever the decision ENDED the transaction in
    `change`. That predicate is not this rule. It is too wide — `decisions.forward`
    on a decision already in `change` moves only the holder, its open request is an
    ordinary `standard` one, and the seal aborted at commit the generic forward the
    transition table gives its own row ("the holder mutation (forward, generic or
    forward-on)") — and too narrow, because the reject-back writes no forward at
    all and was never judged. The obligation belongs where this plan already put
    it (line 3349: "the DB door admits `awaiting_countersign → change` ONLY when
    the transaction also carries the `countersign_rejection` request"), and a
    transition can only be seen from the side that holds OLD. A new DEFERRED
    constraint trigger on `Decision` — `Decision_t4d_disagreement_paired` — reads
    `OLD."status" = 'awaiting_countersign' AND NEW."status" = 'change'` and asks
    for the request at COMMIT, covering all three shapes the transition has:
    reject-back, forward-on, and the `returned` resolution.

    **The standing audit's `pmc` arm gains the predicate the word already means.**
    Round 9 bound `membershipId` and left "membership-less" unbound: the arm asked
    only for an org owner/admin, so an owner carrying an ACTIVE `engineer`
    membership was adopted as a `pmc` too. The projection writer and the backfill
    both spell the condition "NO active membership on the project", and an audit
    that admits what its own writer would never produce is not auditing the
    writer's rule. Through the 4d-i → 4d-iii window `platform_user_holds_role`
    answers from this register, so the fact seals accept `actorRole = 'pmc'` from
    that engineer and FREEZE it.

    §C's harness gains five measured probes and one register: the twin forward
    bundle, the twin transition facts, the twin revision births, the bare
    disagreement and the orphan provisional revision are each RED against the
    previous head and refused by their own seal's message here; the generic
    forward of an already-`change` decision — the write round 8 aborted, reproduced
    against `d65d214e` — must COMMIT; the pre-baseline register probe gains a fifth
    repair for the memberful `pmc` claim; and `STRIPPED_BY_PROBE` declares the
    seals a standalone probe strips rather than an arm, so the coverage tripwire
    can see them and a declaration naming a probe that does not exist fails.

    **ROUND 11 — the adoption audit asked about TABLES and not about COLUMNS, and a
    weakening I chose deliberately was wrong** (#582's review round 11, findings 1-4).

    Two of the four are the same class recurring for a fourth round, and the
    generalisation is no longer about seals: **when a rule is found missing at one
    site, the fix is the sweep of every site the rule names, and the sweep is
    written into this plan so the next round cannot rediscover it.**

    **(1) THE 4d-ONLY SHAPE OF EXISTING TABLES.** Round 8 audited the adopted
    registers; round 9 audited the dark fact tables and the catalog. Neither asked
    the same question of the COLUMNS this unit adds to tables that were already
    there, and on the supported `db push` / P3005 baseline those columns can exist,
    populated, before any raw 4d trigger does — so every value in them is judged by
    nothing and frozen by the next write. The audit now covers the whole class, and
    the class is enumerated here so it stays covered: `ChangeRequest` (the reported
    site: a `countersign_rejection` row no disagreement produced, frozen on the
    spot, unjudgeable by an INSERT-only pairing seal, and occupying the one-open
    slot the real rejection needs), `DecisionApprovalRevision` (a `finalized =
    false` row is an OPEN approval under no chain that the one-flip seal makes
    permanently unfinalizable), `DomainEvent` (a pre-baseline actor pair), and the
    consultation pairs. Before retirement each must be in its LEGACY shape, named
    row by row in the abort.

    **(2) A FROZEN PAIR IS NONBLANK, at its last two sites.** The rule was already
    carried by the consultation pair, the change request's two pairs and the three
    fact tables' pairs. Sweeping it leaves exactly two members unguarded:
    `DomainEvent`'s actor envelope — which round 11 named, and where coherence was
    checked while presence was not, so two empty strings satisfied it and 4d-iii's
    "every new human event carries the pair" would be satisfied by an envelope
    naming nobody — and `DecisionApprovalRevision`'s approval pair, which the
    finding did NOT name and which its finalizer reads to decide what the
    finalizing event says.

    **(3) A NO-OP UPDATE IS NOT A TRANSITION, and round 10's reasoning was wrong.**
    Round 10 bound the provisional birth with the decision's `xmin` and recorded
    why: "pinning a final status here would repeat round 8's mistake of judging a
    transition by the state it left behind". That was a deliberate weakening and it
    was mistaken. `xmin` is satisfied by a write that changes nothing, so a bundle
    could touch an already-`awaiting_countersign` decision and add a SECOND
    provisional revision. Round 8's mistake was reading a state INSTEAD of a
    transition where the transition was the rule; here the state IS the rule,
    because a provisional approval is defined by where it leaves its decision, and
    `Decision_t4d_entry_seal` already owns which transitions may reach that state.
    Two arms now: the birth's decision must END `awaiting_countersign` as a row this
    transaction wrote, and a decision holds AT MOST ONE unfinalized revision — the
    invariant `phase6_t4d_provisional_head` has been assuming all along, since "the"
    head is only well defined when there is one.

    **(4) THE STANDING READ IS FENCED.** The approved-entry seal read
    `platform_role_standing` without the project readiness key, which the delivered
    4b lifecycle trigger takes for publication and for `approved → change` and for
    neither transition judged here. Unfenced, this transaction reads one architect
    and pauses while the last architect's removal takes the key, sees only the
    still-committed open decision, decrements to zero and commits — leaving a
    decision awaiting a countersigner who no longer exists, the exact state the arm
    was written to prevent. `phase6_try_readiness` is taken first, and refuses
    rather than waits, for the reason the revision birth seal gives.

    §C gains two arms (the blank envelope, the blank approval pair), a
    legacy-shape apply probe that plants TWO tables and requires both to be named,
    and the no-op-UPDATE attack driven against the state the provisional arm just
    committed. The readiness fence is proven by a two-session measurement — the key
    held elsewhere, the transition refused by name — and pinned in the contract
    oracle, because a single-session harness cannot hold a lock against itself.

    **ROUND 12 — a rule has DIMENSIONS, and I swept the one the finding named**
    (#582's review round 12, findings 1-6).

    Five of the six are my own recent fixes, and they share one shape that is
    sharper than "fix the class, not the site" — because rounds 10 and 11 both
    claimed to fix the class and both left this behind:

    | the rule | the dimension I swept | the dimension I did not |
    |---|---|---|
    | a fact's shape matches its command | `updateRole`'s two ends | `add`'s source, `remove`'s destination |
    | a frozen pair is trustworthy | nonblank | coherent, and TRUE of the actor |
    | adopt nothing unaudited | the incoming generation | the OUTGOING generation |
    | one act, one flip | per membership | per PROJECT |
    | a pairing holds in BOTH directions | fact → decision | decision → fact |

    **So the check to run before calling a class swept is not "which other sites
    have this rule?" but "which other DIMENSIONS does this rule have?"** —
    direction, scope, generation, shape, property. Sites are found by grep;
    dimensions are not, and every one of these five was invisible to the search
    that found its sibling.

    The sixth is genuinely new and is the one worth reading twice: **the
    project-cascade exception was two facts and neither of them was WHICH
    project.** Trigger depth proves a nested cascade; the transaction-local flag
    proved only that *a* project was being deleted. Delete an event-free project A
    and then hard-delete a membership in a SURVIVING project B, and B's fact rides
    its own FK cascade at depth 2 with A's flag on — permanent evidence erased
    from a project that still exists. The flag is now an accumulating SET of ids
    and the seals ask whether THIS row's project is in it. The original reasoning
    for the boolean is preserved at the site because half of it is still right:
    4c-iii measured that a SINGLE-id flag breaks under a multi-row
    `DELETE FROM "Project" WHERE …`, since the cascades fire after the statement.
    That ruled out one id. It did not rule out a set, and a boolean was the wrong
    conclusion from a correct premise. The flag has TWO readers and the finding
    named one; both move together, which is this round's own rule applied to
    itself.

    §C gains two arms (an `add` receipt backing a live re-role; an approval pair
    that is nonblank and false), a cross-project cascade probe that also asserts a
    project's OWN deletion still carries its facts, a two-crossings probe with its
    one-crossing control, the converse-direction arm on the awaiting entry, and the
    outgoing generation folded into the catalog-conflict probe.

    **ROUND 13 — I VERIFIED A PROJECTION AND CLAIMED THE OBJECT** (#582's review round 13,
    findings 1-6). Five of six are again insufficiencies in my own recent fixes, and the shape is
    one step deeper than round 12's dimensions:

    | the check | what it actually judged | what the rule is about |
    |---|---|---|
    | catalog audit: a JOIN | the INTERSECTION of catalog and compiled set | every row in the generation |
    | catalog audit: a 9-column tuple | the nine columns named | the whole row, `retiredAt` included |
    | awaiting-entry: a COUNT | how many provisional revisions | what is IN the one it admits |
    | revision birth: value, pairing, count | that a head exists | that it is the NEXT head |

    **An inner join is a projection of the row set; a column list is a projection of the row; a
    count is a projection of the rows.** Each of these checks discarded exactly the information
    the rule needed and then reported success. Round 10 learned "counted, not found"; round 12
    learned "one dimension of several"; this is the same error at the level of the CHECK'S OWN
    SHAPE — before asking whether a check covers every site or every dimension, ask what the check
    throws away.

    The two catalog audits are now ONE total audit over `_t4d_catalog_seed`, which carries the
    compiled expectation for BOTH generations; a second audit block was a second chance to
    diverge, and it had already diverged. The outgoing generation is no longer a blanket copy
    either: splitting `activity.created` (finding 3) ends the identical-catalog licence the copy
    rested on, so the divergence is DECLARED at the seed with the key it bends and why, and
    `licences the row copy` still re-derives the rest of the equality from source.

    Finding 2 is the one-site habit again: round 2's finding 10 established marker-aware
    replacement for the correspondence trigger and I applied it there and nowhere else, leaving
    the 4c consultation widening to overwrite its own post-retirement body on a mature replay.

    P28b's replay arm gains BOTH: the
    4d-i migration re-run against a post-4d-iii database, with the architect
    consultation request COMMITTING afterwards, RED against the unconditional
    replace, which refuses it; and, on that same replayed database, an audit row
    inserted with a catalog-valid event of the right type but no fact and no
    transition REFUSED afterwards — RED against the unconditional create, which
    admits it because the weak body is all that survives the replay. That marker is one row in a NEW, sealed platform table
    `RolloutRetirement(unit TEXT PRIMARY KEY, retiredAt, retiredBy)` created
    by 4d-i's permanent portion — NOT a row on `OutboxOperatorAction`, whose
    4c-iii-r verifier (`verifyMarkerSeals`) keeps a CLOSED trigger inventory
    that a fourth trigger would fail. The new table carries the 4c-iii-r seal
    SHAPE on its own surface — creation gated to the writing path by a `SET
    LOCAL vitan.phase6_4d_retire = 'on'` flag that only 4d-iii's transaction
    sets (mistake-proofing in the 4c-iii-r sense, "unforgeable by ACCIDENT" —
    never a privilege boundary, which this deployment's single table-owning
    role could not honour), UPDATE and DELETE refused, no-TRUNCATE — and
    `verifyMarkerSeals` is probed UNCHANGED after 4d-i and 4d-iii. Every
    statement is `IF NOT EXISTS`/`IF EXISTS`/`CREATE OR REPLACE` so a
    partial apply retries. `TRUNCATE_SEALS` gains EIGHTEEN entries across
    4d-i and 4d-ii — `RolloutRetirement_t4d_no_truncate` among them (#572's
    review round 25, finding 5: the count said seventeen, the marker's own seal
    was required a few lines above, and the paragraph then claimed it was
    "registered so the coverage tripwire knows every seal" while omitting it
    from the only registry that does the knowing). The registry is the seal
    INVENTORY the coverage tripwire reads; it is not the reset's table list, and
    the two are separate — `RolloutRetirement`, the consumer catalog with its
    activation register, and the lease register are registered here AND excluded
    from every sanctioned reset's table list, so their seals are never disabled
    by a reset and the tripwire still sees them. The eighteen: the three fact tables,
    `ProjectRoleStanding_t4d_no_truncate`, `Membership_t4d_no_truncate`,
    `MembershipTransition_t4d_no_truncate`, `ChangeRequest_t4d_no_truncate`,
    `ExternalEffectCatalog_t4d_no_truncate`, `Notification_t4d_no_truncate`
    (#560's review round 1, finding 10: the count said nine and the list
    named eight), `OutboxConsumerActivation_t4d_no_truncate` and
    `ReleaseLease_t4d_no_truncate` (#560's review round 2, findings 2 and 6:
    evidence registers that refused UPDATE and DELETE but not TRUNCATE),
    `ProjectUserStanding_t4d_no_truncate`, `UserIdentity_t4d_no_truncate` and
    `ProjectEventStream_t4d_no_truncate` (#561's review round 1, findings 1
    and 7), `OrgUserAuthority_t4d_no_truncate` (#562's review round 1,
    finding 2) and `DomainEventPairingClaim_t4d_no_truncate` (#568's review
    round 2, finding 2: the register §A.2 declares non-truncatable and the
    reset truncates with `DomainEvent` was missing from the closed
    inventory, so every reset reaching it would have aborted) and
    `ProjectOrg_t4d_no_truncate` (#572's review round 15, finding 1) —
    while `RolloutRetirement` (a rollout fact, never test data), the
    consumer catalog with its activation register and the lease register
    (bootstrap and rollout evidence) are deliberately NOT in the reset's
    table list: their no-TRUNCATE seals are never disabled by a reset and
    are registered so the coverage tripwire knows every seal. `ALWAYS_EXECUTE` gains the
    migration (raw guards a `db push`
    baseline cannot have); `scripts/migrate.sh` gains
    `report_4d_i_migration_failure`; `docs/RUNBOOK.md` gains §P6T4D; the
    migration corpus pin advances. Its integration suite is the
    seal-stripped harness of §C; `upgrade-proof.sh` gains the P42 backfill
    assertions over the legacy fixture, the old-write-shape inserts
    succeeding under the kept defaults, the reseed of a database holding an
    active and a soft-removed architect succeeding through the sanctioned
    membership path, the planted hostile `Membership` and
    `User` rows driving abort → re-role → `migrate resolve --rolled-back` →
    redeploy through the real runner, the register-equals-count assertion,
    and one hostile insert per seal. **Deployed dark**: no contract, no
    command, no route, no reader; a still-serving 4d-ii-less instance cannot
    produce any new value, and the FIVE 4d-sealed writers it can still run —
    the no-chain approve, the standard `requestChange`, `withdrawChange`,
    `requestConsultation` and `respondToConsultation` — each already write
    the event, the audit row and the fact the correspondence requires in
    their own transaction, with a NULL envelope pair, no notice where the
    delivered path writes none and the delivered push shapes, which the
    seals admit exactly (the legacy-writer table of §A.3 obligation 7 —
    #567's review round 1, finding 2); the approve keeps writing its feed
    row without `eventId`, which the seal admits until 4d-iii. **4d-i is expected to
    EXCEED the standard budget on probes alone and its packet MUST carry
    the large-unit evidence** (#564's review round 2, finding 3: "argues
    `justified-large`" required neither the marker nor the matrix the
    repository's scope gate blocks on): it declares the exact
    `<!-- review-size: justified-large -->` marker with the visible
    restatement, completes all six invariant-matrix rows and the five
    pre-review checks, lists its file inventory, and carries its
    `<!-- migration-scope: inseparable -->` marker with the stated
    boundary above — exactly what 4d-ii's paragraph requires of 4d-ii.

  - **4d-i-b, the PAIRING SWITCH-ON — a migration-only unit carved out of
    4d-i on JagPat's instruction (#582's review round 6, finding 3)**. 4d-i
    installs the pairing MECHANISM and leaves it switched off: the
    `DomainEventPairingClaim` register with its writer-depth, append-only and
    no-TRUNCATE seals, the `platform_claim_event_pairing` primitive, the
    kernel-owned `DomainEvent_t4d_pairing_claimed` seal, and the catalog's
    `pairingRequired` column — seeded `false` on every one of its rows, so no
    event type demands a claim and the mechanism is dark in the same sense the
    rest of 4d-i is. 4d-i-b is the unit that TURNS IT ON, and it is one unit
    because the three pieces are inseparable in the only direction that
    matters: flipping a type to `pairingRequired` without its claimant refuses
    every legitimate event of that type at commit, and installing a claimant
    for a type still at `false` claims into a register nothing reads. Its
    inventory is exactly:
    (a) `ChangeRequest_t4d_paired`, the ONE deferred pairing seal on
    `ChangeRequest` — the closure-and-restoration bundle in both directions
    (#558's review round 1, finding 2) and the OPENING bundle in both
    directions (#568's review round 1, finding 3), with the seed's DL-003
    plant its only admitted bypass and the `decision.change_requested` /
    `decision.change_withdrawn` claims it owns (#572's review round 11,
    finding 1);
    (b) the REMAINING per-branch CLAIMANTS the §A.3 correspondence table's
    claimant column names — the consultation request and response fact seals,
    and the `DecisionApprovalRevision` birth seal for the reapproval branch
    (#572's review round 9, finding 1) — every other fact in each bundle
    staying verification-only. 4d-i already installs ONE of them, the
    re-notification's `DecisionEvent_t4d_renotified_claim` (#582's review
    round 5, finding 7), and that is not a breach of round 11's rule: the rule
    forbids a claimant installed LATER than the flip, because that leaves a
    window in which every legitimate event of the type is refused at commit. A
    claimant installed EARLIER writes claim rows nothing yet demands, which is
    inert — and it is what keeps the two units independently revertible;
    (c) the six catalog rows flipped to `pairingRequired = true` —
    `decision.approved`, `decision.reapproved`, `decision.change_requested`,
    `decision.change_withdrawn`, `decision.consultation_requested` and
    `decision.consultation_responded`; the three 4d-ii types
    (`decision.forwarded`, `decision.awaiting_countersign`,
    `membership.standing_changed`) are not compiled yet and are declared by the
    unit that adds them, with their claimants beside them.
    **The split CHANGES how that flip is delivered, and this is the one thing
    it is not free.** Inside 4d-i the flip rode the catalog's FIRST INSERT, so
    the rows were simply born `true` at coverage `b731a407…`. Split out, they
    are already committed `false` at that version and
    `ExternalEffectCatalog_t4d_frozen` admits no UPDATE but the retirement
    stamp — its own refusal says a definition changes by a NEW coverage
    version, never in place. So 4d-i-b adds `pairingRequired` to the compiled
    catalog's `canonicalCatalog()` PREIMAGE, which is what makes the flip a new
    `effectCoverageVersion()` and lets 4d-i-b insert a fresh generation beside
    the old one; a still-serving release keeps resolving its own rows through
    the version its intents carry, which is the mechanism the column was built
    for. `pushOptional` is in that preimage for the same reason (#582's review
    round 5, finding 4).

    **And the rule that mechanism implies binds 4d-i itself, not only 4d-i-b**
    (#582's review round 8, finding 3). `DomainEvent_t4d_envelope` resolves an
    intent by the EXACT `(coverageVersion, effectKey)` pair from the moment
    4d-i commits — the intent has no dark window, unlike the actor pair — so
    ANY migration that changes `effectCoverageVersion()` must seed the OUTGOING
    generation beside the incoming one, or every event a still-serving process
    emits during the rolling drain is refused, which is an outage for the length
    of the drain rather than a dark rollout. 4d-i changes it: adding
    `pushOptional` to the preimage moves the version from `6313b00c…` (what
    `origin/main` computes) to `b731a407…`, and 4d-i seeded only the second.
    The outgoing generation is seeded by COPYING the incoming rows, and that
    copy is licensed by one measured fact — `pushOptional` was introduced to
    DESCRIBE emit paths the previous release already takes, so the two releases
    declare the same policy for all 107 keys and hash apart only because one of
    them spells the extra tuple element. `phase6-t4d-i-catalog-generations.test.ts`
    re-derives that equality from source on every run, so the licence cannot
    outlive its proof; a release that genuinely changes a key's audience,
    invalidation or push obligation seeds the outgoing generation with the
    OUTGOING policy instead. The generation leaves service by RETIREMENT in
    4d-i-b/4d-iii, once no lease serves it, which keeps it resolvable for
    history while refusing to back a new event.
    **Why it is a separate unit rather than a later paragraph of 4d-i**: 4d-i
    reached #582's round 6 already carrying the whole of §A.3's fact/seal
    surface, and the pairing switch-on is the one part of it whose failure mode
    is a REFUSAL of delivered traffic rather than a dark addition — it deserves
    its own probe surface (P29b's claim arms and P37's unclaimed-event arms)
    and its own review, and folding it into a unit already at the lifecycle
    limit would have bought a larger diff for a smaller reading of it. It is
    ORDERED between 4d-i and 4d-ii-a: 4d-ii-a's four commands write the facts
    the claimants read, so the claim must be in place before those commands
    exist, and 4d-i-b's seals are all over tables and columns 4d-i already
    delivered — it adds no table and no column. **Its diff surface** is
    `prisma/` (one migration and the seed), `test/`, and under `src/` EXACTLY
    the compiled external-effect catalog's `pairingRequired` declarations and
    the preimage change (c) requires — the source the seeded column is derived
    from and the seed tripwire pins; no service, controller, query, emitter,
    participant or UI change, so it keeps 4d-i's migration-only character. Its
    packet carries the standard markers; it is not expected to need
    `justified-large`.

  - **4d-ii, the service/role/UI unit — SPLIT into 4d-ii-a, the SERVER
    unit, and 4d-ii-b, the CLIENT unit** (#567's review round 1, finding 4):
    4d-ii-a carries every item of the inventory below EXCEPT the web items
    enumerated for 4d-ii-b at the end of this bullet, and lands DARK — while
    the six reservation doors stand, every shape the `countersign-v1`
    boundary strips or refuses is unrepresentable and the in-command
    lesser-client refusal fires only under an ACTIVE chain, so the server
    refuses no deployed browser session and needs no client to ship. The
    inventory: the role fan-out (§A.1 — every
    mirror, the policy rows, the web lists (4d-ii-b), the DESIGNATION
    fan-out, the
    `deciderPush` architect arm, the `deciderPushTarget` arm, `countPending`);
    the four commands (`decisions.forward`, `decisions.countersign`,
    `decisions.disagree` with its two paths,
    `decisions.resolveStrandedCountersign`) on the command ledger with
    idempotency keys and `lockProjectReadiness` in the canonical order, each
    writing its fact with the frozen pair resolved INSIDE `executeCommand.run`
    under §A.3 obligation 3's corrected contract — the NAME from `UserIdentity`
    with the identity row taken `FOR UPDATE` after `Membership` in the canonical
    order, the ROLE by the window disposition (the race-free derivation until
    4d-iii re-points it), NEVER from the token read before the transaction
    opened (#572's review round 13, finding 4: round 12 corrected §A.3 and left
    this inventory saying "from the actor's token", which is the pre-transaction
    read whose staleness the correction exists to remove — a display-name update
    committing between `resolveActor` and the fact's INSERT would make the seal
    reject a valid forward, countersign, disagreement or stranded resolution),
    emitting its event and writing its audit row and feed row (with
    `eventId`) in the transition's transaction; the approve CAS landing
    `awaiting_countersign` under a chain with the provisional notice, the
    frozen `approvedFrom`/`approvedByName`/`approvedByRole`, and its `decider`
    and `forward` cancellations; the countersign demand's recipients and the
    forward push's recipients resolved under the lock and passed as
    `targetUserIds` (the `DispatchInput` sibling of `targetUserId`,
    `buildDispatchIntent` admitting it only for the two frozen-audience
    families, the platform's `deliveryRowsFor` projecting it into the delivery
    payload — `deliveryFor` is retired; #563's review round 1, finding 5: this
    checklist still named the process-local copy the standalone emitters do
    not have); every decisions notification writer minting its event id up
    front, passing it through `EmitInput.eventId` and stamping the notice's
    `eventId` and `kind`, **with this unit's catalog-data migration EXTENDING
    `Notification_t4d_binding_bound` with the same-transaction INSERT converse
    §A.3 now states** — a row whose `eventId` is non-NULL admitted only when
    that `DomainEvent` is inserted in the same transaction, and zero rows
    required for the no-notice branches — and its hostile probe, the late
    kinded insert against a committed no-notice event (#572's review round 14,
    finding 5: round 13 wrote the converse into the contract and taught this
    inventory only to POPULATE the columns, so an implementation following the
    staged list still admitted the undeletable planted notice), every feed reader (the
    snapshot builder, the `decisions.inbox` fold and rebuild) rendering a
    kinded row from its kind, event and frozen fact under the renderer
    tripwire and filtering it through `decisionVisibleToViewer` for its bound
    decision, the withdraw's notice retirement narrowed to kind-less rows,
    and the orgs participant's `effectiveRoleHolderUserIds` wrapping
    `platform_role_holder_user_ids` — for `architect` from this unit, for
    `pmc`/`client` once `rollout.phase6_4d` reads `open` (the window rule of
    §A.2); the `withdrawChange` refusal;
    **the CONSULTATION CYCLE converted to finalized-only at every producer and
    reader named in §A.2's trace — `decisions.service.ts:638` and `:764`,
    `decisions.query.ts:348` and its projection fold at `:203`,
    `decision-serialize.ts:96` — with `viewerIsConsultee` and the two client
    selectors moving with the DTO field they read, and with
    `decisions.service.ts:1147` and `:511` DELIBERATELY unchanged for the
    reasons stated there** (#572's review round 16, finding 3);
    `decisions.approvedRef` returning `revisionFinalized` and refusing an
    unfinalized head, with the material and labour create/revise writers
    spreading it explicitly, the two cancellation copies carrying it forward,
    and the writer sweep; `requestChange` recording `sourceCommandId` AND
    the frozen `requestedByRole`/`requestedByName` pair resolved INSIDE
    `executeCommand.run` under §A.3 obligation 3's uniform contract — the NAME
    from `UserIdentity` with the identity row `FOR UPDATE`, the ROLE by the
    window disposition — and NOT copied from the pre-transaction `resolveActor`
    read (#572's review round 14, finding 7: round 13 carried the corrected
    contract onto the four NEW commands and left this delivered one saying
    "from the resolved actor", so a display-name change committing between
    `resolveActor` and the request's own transaction would make the trailing
    seal reject a valid standard request — the same defect round 12 fixed for
    the facts, surviving on the one writer that predates them) — the STANDARD
    writer stating the pair exactly as the consultation
    and rejection writers already do, so the trailing seal 4d-iii installs
    meets a writer that satisfies it rather than one that cannot (#572's
    review round 1, finding 1: round 2 on #560 moved the SEAL's inventory to
    require the pair and this WRITER inventory was not moved with it, so even
    a keyed, current-version standard request would have inserted the NULL
    pair and aborted at commit) — with
    its receipt naming the created request row; `emitEvent` writing the
    envelope's `actorRole`/`actorName` from a kernel `EventActor` widened to
    the FULL `Actor`, `AttributionActor` carrying the pair through the
    commercial, procurement, labour and inventory seams, and
    `OrgsParticipant.resolveUserIdentity` returning the display name
    (#555's review round 2, finding 1, staged here — #556's review round 1,
    finding 3); the three orgs membership
    mutations becoming commands writing their `MembershipTransition` row and
    emitting `membership.standing_changed` on a standing flip, each opting
    into server key synthesis so the deployed tabs' keyless member calls keep
    committing through the 4d-ii-a → 4d-ii-b window (§A.2; #572's review
    round 3, finding 4);
    `ensure-accounts` validating its `ACCOUNTS_JSON` before the first write
    and refusing an `architect` entry or backfill role, the four
    `Membership` writers outside `members.service` (the sign-in
    provisioning — made ONE transaction, user + membership — project
    creation, the seed, `ensure-accounts`) taking `lockProjectReadiness`,
    and the `OrgMembership` owner/admin writers (`orgs.service.ts`, the
    seed's and `ensure-accounts`' org upserts) taking it over every project
    of the org in ascending project id (#556's review round 1, findings 1
    and 2; round 2, findings 2 and 4); the `decisions.effects` activation
    handler's current-standing judgement recording a stale activation `noop`
    (#556's review round 2, finding 1);
    `decisions.forward`, `decisions.create`/`updateDraft`,
    `MembersService.add` and the role-update command refusing 409 while the
    reservation stands, and the shell's ONE `rollout.phase6_4d` read; the
    existing targeted catalog entries admitting `architect` and the
    `decision.consultation_responded` ceiling widened to `['pmc',
    'architect']` with the `respond` emitter persisting the requester's
    frozen request-time role, and `consultation.request` writing
    `requestedByRole` under the seal's requester arm; the `ReleaseLease`
    writer (startup registration + lease renewal) and the
    `rollout:drain-evidence` CLI; `syncConsumerCatalog` INITIALIZING a row's
    `dispatchRule`/`subscribedEventTypes` from the compiled contract when it
    CREATES that row, and VERIFYING an EXISTING row's persisted rule against the
    compiled contract, refusing on drift and never rewriting it — the two halves
    stated separately because they are different operations (#560's review round
    1, finding 7 established the verify-only half against a checklist that said
    "writing" of every row, and it stands for rows that already exist; #572's
    review round 24 finding 2 established the creation half, since this function
    is the DELIVERED creator that the shipped suites call at runtime; #572's
    review round 25, finding 6 is that §A carried the correction and this
    inventory — the list an implementation follows — still said "never writing
    them", which would have left every runtime-created consumer ruleless);
    the named `OutboxConsumerCatalog_t4d_registration_barrier` BEFORE INSERT
    trigger taking the registration key EXCLUSIVE on every catalog insert
    (#572's review round 25, finding 7 — §A named the key and no installer); the delivery-row rewrite — the platform's
    `deliveryRowsFor` projection called by `materializeDeliveries` and
    `expandMissingDeliveries`, `deliveryFor` retired — the
    `OutboxConsumerActivation` register, its frozen `active` mirror and the
    operator `outbox:consumer` command are specified in this unit's COMPANION
    DOCUMENT, `2026-09-09-outbox-consumer-activation.md`, and not in this list;
    the implementation of this list READS the ACTIVE set they define (#572's
    review round 14, finding 2: this list once restated all three while §A
    named them elsewhere and the text below already relied on their
    catalog-INSERT trigger, so an implementation following it would redefine or
    duplicate schema, seals and operator behaviour specified once already);
    What stays here is 4d's own consumer REGISTRATION and its delivery changes:
    the `DomainEvent_t4d_deliveries`, `OutboxDelivery_t4d_bound` and
    `OutboxDelivery_t4d_frozen` seals installed by THIS unit's catalog-data
    migration beside the rule columns it writes (§A.3 obligation 7 —
    #560's review round 1, findings 1, 2, 4 and 6); the kinded feed query
    as the TWO owner-provided queries inside one REPEATABLE READ
    transaction — the platform's notification query and the decisions
    module's status query, no join (#560's review round 1, finding 8: this
    checklist said "in one statement", the cross-module join §A.3
    refuses); `lockOrgStanding` taken
    by project creation — with the creator's owner/admin standing RE-JUDGED
    under the key before the insert — and by every owner/admin
    `OrgMembership` writer before the project keys; the exact `revisionId`
    in every `decision.approved`/`reapproved` payload from the direct
    approve, the countersign and the `completed` resolution, and the kinded
    green notice rendering from the revision its event names; the kinded
    feed readers' ACTIONABLE-kind suppression for a withdrawn decision;
    `consultationRespondedPushTarget` widened with the withdrawn-audience
    arm; the consultation predicates widened and the roster loaded on the
    consultation surface; the architect's Decision Log controls; the
    decisions-owned ORDERED consumer `decisions.effects` — registered
    INACTIVE by this unit's catalog-data migration and activated by 4d-iii's
    appended register row after the drain. **Its activation HEAD comes from the
    companion document's catalog-INSERT trigger, not from that document's
    backfill** (#572's review round 13, finding 5): the backfill runs in 4d-i,
    before this catalog row exists, so an answer resting on backfill ORDER would
    leave this consumer — registered by a LATER migration of the same unit —
    without a head, and both the operator no-op path and 4d-iii's head
    verification would have nothing to read. The companion document's answer to
    its own round-1 finding 4 is the mechanism this row relies on: an AFTER
    INSERT trigger on `OutboxConsumerCatalog` appends every new row's `seq = 1`
    baseline in the same statement, whoever performs the INSERT — this
    migration's registration included. Nothing is owed here beyond registering
    the row.

    **AND THE STAGING DEPENDENCY IS INTERNAL TO THIS UNIT** (#572's review
    rounds 17 and 18, one P1 each, RESOLVED BY REUNIFICATION rather than by the
    instrument either round asked for — round 22). Both rounds read the
    activation material as another unit's and reasoned about which of two PRs
    the Board might take first: round 17 answered with a post-merge obligation
    that named no installer, and round 18 corrected that by setting
    `blocking_directive: phase-6-4d-unit1-prerequisite` in `docs/STATUS.md`, so
    that `assessRunnerState` — whose directive branch returns before its
    `open_pr` branch — would refuse to start 4d-i against a `main` without the
    register. Both answers addressed a hazard that no longer exists. The
    activation document is part of THIS unit and lands in THIS commit: there is
    no inverted merge order to guard against, no file that can be absent from
    `main` while the rest of the unit is present, and no separate work item for
    a directive to point a producer at. The directive and its completion test
    are therefore REMOVED from `docs/STATUS.md` in this same change — a
    directive naming a prerequisite that is not a separate work item would park
    the runner on work nobody can pick up — and `assessRunnerState` and
    `assessPostMergeRunnerState` were RE-RUN on this tree to confirm the
    resulting state is actionable, rather than argued to be. What SURVIVES from
    those rounds is the ordering that was always real and is now purely
    internal: 4d-i installs the register, its seals and its baseline backfill;
    4d-ii registers the `decisions.effects` catalog row; and that row's head
    comes from the catalog-INSERT trigger rather than from the backfill —
    stated immediately above, and enforced by migration order inside one unit
    rather than by a claim about which PR number lands first — with
    `decisionsManifest.consumesEvents` gaining `membership.standing_changed`
    and the platform-owned `EventStreamQuery.latestPosition`; the
    per-recipient pre-send hook and the cancellation-by-subject inventory in
    the ONE lock order with the `targetUserIds` narrowing arm on
    `cancelQueuedPushBySubject`; the `countersign-v1` client contract with
    its transport-layer interceptor, the in-command refusals and the
    completeness tripwire; the reader enumeration of §A.2, the shared status
    tripwire, the Inbox branch, the client's approval confirmation copy; the
    `countersignRequired` kernel overlay through `RoleStandingQuery`; the
    `decisions.inbox` projection row/fold/rebuild/filter carrying the
    awaiting state, the forward-installed holder and the non-`standard`
    origin (live == projection == rebuild); **the two changed consumers'
    DURABLE contract versions bumped** — `webpush.notify` (`catalogVersion` 2
    → 3, for the two new claim families and `targetUserIds`) and
    `decisions.inbox` (2 → 3) — with the `OutboxConsumerCatalog` rows and
    `ProjectionGeneration.catalogVersion` migrated in 4d-ii's OWN
    catalog-data migration (the 4c-ii precedent,
    `20271116000000_phase6_t4c_ii_rollout_fence`), which ALSO writes the
    widened external-effect catalog's rows at the new coverage version into
    `ExternalEffectCatalog` beside the old version's (under the gate; the old
    rows stay for the drain) and registers `decisions.effects` (guarded as a whole on the consumer's catalog row
    being ABSENT, so a replay is a no-op) and joins `ALWAYS_EXECUTE` (a
    restored pre-4d-ii database would keep its catalog rows at version 2
    while the binaries declare 3, and `syncConsumerCatalog` would refuse
    EVERY upgraded process at startup), so a restarted or rolled-back
    pre-4d-ii process is refused at startup and can never claim the sole
    ordered delivery — that is what makes the drain DURABLE rather than a
    one-time observation; 4d-ii-a therefore carries this ONE catalog-data
    migration beside its service change and declares the migration seam
    inseparable in its packet for the reason 4c-ii did (the version and the
    code that declares it must move together); the socket consumer is not
    bumped. **4d-ii-a is a CATALOG CHANGE, staged as one**: its new push families and
    widened targeted entries change the sealed external-effect coverage
    hash, and the delivered `OutboxBootstrap` REFUSES to start in
    `OUTBOX_SENDER_MODE=outbox` while the persisted seal differs from the
    compiled catalog, so its staging follows `docs/RUNBOOK.md`'s
    catalog-change sequence, written into the packet as steps: drain the old
    fleet to zero instances → deploy 4d-ii-a in legacy/shadow sender mode →
    rebuild projections → `outbox:status` clean → `outbox:seal-external`
    recording the NEW coverage → restart in outbox mode, the startup
    validating the seal — BEFORE 4d-iii. **Still chain-off AND forward-off
    everywhere**, because the reservation stands on all six doors: the unit
    ships every reader and writer while no project can exercise them, which
    is what makes the previous-release drain a pure operational step.
    4d-ii-b's STATUS fold — the last unit before the drain — SETS
    `blocking_directive: phase-6-4d-previous-release-drained`, and the
    minimum release the directive names is 4d-ii-a's, the server release
    carrying the bumped consumer contracts.
    **4d-ii-a is expected to EXCEED the standard budget and its packet MUST
    carry the large-unit evidence** (#560's review round 1, finding 9): it
    declares `<!-- review-size: justified-large -->` with the visible
    restatement, completes all six invariant-matrix rows and the five
    pre-review checks, and lists its file inventory. The seams were
    considered and are stated in that packet, not assumed: the migration
    seam is INSEPARABLE for the reason above (the catalog version and the
    code that declares it move together, as 4c-ii's did); the service/UI
    seam is SEPARABLE and TAKEN (#567's review round 1, finding 4): an
    earlier text claimed the `countersign-v1` boundary makes a server
    without its client refuse every deployed browser session, which is
    false under this plan's own staging — while the doors stand the
    interceptor strips nothing that exists, the architect refusals meet no
    architect, and the in-command refusal fires only under an active chain
    no project can have — so 4d-ii-a lands dark behind every existing tab.
    **4d-ii-b, the CLIENT unit**: the web gateway declaring `countersign-v1`
    on every API-bound request with the client-boundary `fetch(` tripwire
    (§A.2); the web role fan-out — the role lists, the decider picker's
    `architect` designation and the Team role pickers following the shell's
    `rollout.phase6_4d` read; the Forward affordance; the Inbox
    `awaiting_countersign` branch and the reader enumeration's web arms
    under the shared status tripwire; the architect's Decision Log controls
    (Countersign / Reject back / Forward on); the approval confirmation copy
    reading `countersignRequired` and the success copy following the
    returned status; the roster on the consultation surface; the store's
    handling of the additive fields and the `DecisionForward` DTO; the shell
    badge rendering `countPending`'s count; and the web arms of P28b, P29c,
    P30, P31, P33 and P34, its browser proofs driven against the 4d-ii-a
    server with the doors still standing (the boundary probed BEFORE the
    role is enabled, as §A.2 states). It carries no migration and declares
    the marker its size warrants — `justified-large` with the six-row
    matrix if it exceeds the budget. What CAN be cut is already outside the
    pair: the dark seals (4d-i), the reservation retirement and the
    standing-writer seals (4d-iii), and the drain.

  - **The drain attestation** — the operator states that every process older
    than the 4d-ii-a release (the server release carrying the bumped
    consumer contracts; 4d-ii-b is client-only) is stopped or drained, as an
    `OPERATOR-ATTESTATION`
    on the controlling issue naming the directive and the minimum release,
    carrying no agent-generation marker — the attestation covers processes
    ALREADY RUNNING, which no code can observe; the bumped consumer contracts
    fence every process that STARTS, which keeps the attested state durable
    afterwards; browser tabs stand behind the `countersign-v1` boundary
    (§A.2). **BOARD DECISION carried from 4c** (2026-08-29, on PR #480): an
    operator-declared directive, NO automated drain actor. Why the drain
    matters for 4d, stated concretely: a pre-4d instance's Prisma client
    fails to READ any `Decision` row whose `status` is a value its generated
    enum does not know, and its zod `TokenRole` refuses to mint a JWT for an
    `architect` member — so a project whose chain activates while an old
    instance still serves is a split brain of exactly 4c's class. The
    reservation makes that state unreachable until the fleet is attested
    drained. Nothing an agent writes supplies the attestation (the #530
    lesson). **What the runner CAN verify, it verifies — fail-closed —
    and the Board decides whether that verification replaces the
    attestation** (#558's review round 1, finding 4, re-raised on #560,
    #562, #563, #564, #565, #566, #567 and #568: a gate only a human can
    clear leaves an autonomous loop `in_progress` with no human standing by;
    a review finding cannot lift a recorded Board decision, and this plan
    does not pretend to — it adds the evidence and raised the question on
    #482, where the controlling answer is recorded: comment 5569586836,
    2026-09-07 — the user's standing instructions RETAIN human production
    attestation; evidence does NOT replace the direct explicit operator
    attestation; a review request for greater autonomy cannot authorize its
    removal, and no agent-authored statement can supply a policy change or a
    runtime fact; `main`'s `AGENTS.md` bullet, merged as #569 on the user's
    direct instruction to that session, says the same and is left exactly
    as `main` carries it — the lifted-gate folds of `1a2ba97` and `b0d5399`
    are both reversed, see the lineage header). Two pieces of trusted
    autonomous evidence, both shipped in 4d-ii:
    (i) the platform-owned `ReleaseLease(instanceId, catalogVersion,
    release, startedAt, leaseUntil)` register — every serving process writes
    its row at startup with the consumer-catalog version compiled into it
    (the same durable generation identity `syncConsumerCatalog` already
    judges) and renews `leaseUntil` on an interval while it serves; the
    row's identity is FROZEN after insert (`ReleaseLease_t4d_frozen` admits
    only a `leaseUntil` change, and only a non-decreasing one), DELETE is
    refused and `ReleaseLease_t4d_no_truncate` sits in `TRUNCATE_SEALS`, so
    a live lower-version lease can neither be re-versioned into the minimum
    nor removed before the preflight reads it, and a stopped process's
    lease simply expires and stays as history (#560's review round 2,
    finding 6: an unsealed register would have let the proof be edited
    into passing while the old process served) — so "no
    live lease at a catalog version below the minimum" is in-database proof
    that no process of an OLDER generation that started AFTER the register
    existed is still serving — complete for every drain from 4d-ii on,
    4d-iii's own included; and (ii) for the processes that predate the
    register (the 4d-i-era fleet is the pre-4d code and writes no lease),
    the deploy platform's running-container inventory: `rollout:drain-
    evidence` reads Coolify's API for the application's running containers
    and asserts every image is at or after the minimum release, failing
    closed on any container it cannot classify, and records its evidence
    (the inventory, the minimum release, the verdict) as a `DRAIN-EVIDENCE`
    comment on the controlling issue — an OBSERVER of the platform's state,
    never an actor that drains anything, which is the thing the Board
    refused. The gate therefore reads: `phase-6-4d-previous-release-drained`
    clears on the direct explicit OPERATOR-ATTESTATION, which is REQUIRED,
    with the autonomous evidence as CORROBORATION the runner verifies and
    records beforehand — never a substitute, never a reason to treat a wait
    for genuinely required operator evidence as permission to clear the
    gate. The runner's own steps (`rollout:drain-evidence`, then 4d-iii's
    migration preflight re-checking the lease register) are complete and
    repeatable without a human and fail closed on their own; the gate as a
    whole clears only when the attestation exists beside them. Any removal
    of the human requirement is the user's separate decision, given in the
    user's own voice — never inferred from a review finding, a coordinator
    note, a relayed or unmarked comment, a selection a coordinator entered
    into a session, or this plan.

  - **4d-iii, the reservation retirement**: a migration-only unit whose
    transaction, after its `SET LOCAL` gate, FIRST takes `LOCK TABLE
    "Project", "OrgMembership", "Membership" IN SHARE ROW EXCLUSIVE MODE`
    in that one order and holds it to commit — the fence behind which
    every write of those tables from any writer, service or direct, ends
    before the snapshot and none commits before the doors (#563's review
    round 2, finding 1) — and takes NO org key; THEN re-projects
    `ProjectUserStanding` and `OrgUserAuthority` from the orgs truth, org
    by org in ascending id, **under `SET LOCAL
    vitan.phase6_4d_standing_reprojection = 'on'` — the second gated writer
    arm of the registers' writer-depth seal, admitted only while this fence
    is held and only on these two per-user registers (§A.2)**, without which
    the repair is a depth-1 register write the seal refuses and 4d-iii rolls
    back instead of retiring the doors (#572's review round 5, finding 4),
    recording the diff in its closing report
    (#562's review round 2, finding 3); re-points the consultation request
    seal's requester arm onto `platform_user_orchestration_authority`
    (`CREATE OR REPLACE`, the body otherwise 4d-i's — the register judges a
    live seal only once verified, the window rule of §A.2, #566's review
    round 2, finding 1); and only then drops
    ALL FIVE reservation doors with their shared function, drops the two
    kept finality defaults (`finalized`, `revisionFinalized` — after the
    drain only writers that state the pin remain), **REPLACES the body of
    `DecisionEvent_t4d_correspondence` — the DEFERRED INSERT constraint trigger
    4d-i created — with the FULL converse §A.3 states: 4d-i already carries the
    TRANSITION-derived same-transaction event, so this stage adds the FACT and
    its TRANSITION rather than introducing the rule or the trigger (#572's review
    round 20 finding 2; round 21 findings 1 and 3; round 23 finding 1, which
    replaced round 21's kind → type function with the (kind, committed status)
    table §A.3 closes). **This body is the one 4d-i's own MARKER-AWARE create
    installs when `RolloutRetirement` is already present** (round 23, finding 2),
    so a P3005 baseline replay of a mature database cannot downgrade the live
    seal to the weak body while waiting for this stage to run** — each of the EIGHT listed audit kinds
    (`countersign_renotified` among them, #572's review round 19)
    requiring its fact, its transition and its `DomainEvent` in the same
    transaction, judged AT COMMIT because the delivered writers insert the audit
    row before they emit (#572's review round 15, finding 2), with the seed's
    `DecisionEvent` plants disabling this name beside
    `DecisionEvent_t4d_append_only`, and with the fabricated
    standalone insert of each kind as its hostile probe and the revision
    sequence asserted unmoved (#572's review round 14, finding 4: round 13 wrote
    the converse into the contract and this staged inventory installed only the
    `ChangeRequest` seal, so an implementation following the stages still
    permitted the late `approved` row that becomes immutable and inflates the
    next approval's version) — and installs the TRAILING
    seals — `ChangeRequest_t4d_provenance_required`, in FOUR ARMS because this
    table is written by four different OPERATIONS and an INSERT-time seal
    reaches only one of them (#572's review round 8, finding 2; round 12,
    finding 1). **The INSERT arm**: `sourceCommandId` AND the frozen
    `requestedByRole`/`requestedByName` pair required on every new
    `ChangeRequest` row whatever its origin; `status <> 'open'` on INSERT
    is REFUSED OUTRIGHT (#572's review round 13, finding 1); **AND an inserted
    row must carry the CLOSURE SET EMPTY — `resolvedById`, `resolvedAt`,
    `resolution`, `resolvedByCommandId`, `resolvedByRole` and `resolvedByName`
    all NULL — with the closure arm admitting only a NULL → COMPLETE transition
    of that set in the closing statement** (#572's review round 16, finding 1).
    Round 13 refused the row born closed and said nothing about what an OPEN row
    may carry, which leaves the closure provenance forgeable one step earlier:
    a receipt-holding writer inserts a correctly paired, genuinely open request
    with the resolver columns ALREADY populated — a receipt it reserved at
    insert time, a truthful pair for itself — and later flips `status` alone.
    The closure arm fires on that flip, reads a complete set in `NEW`, finds
    every column present and every value truthful, and admits a closure whose
    provenance was minted before the act it claims to record. Requiring the set
    empty while open, and the transition NULL → complete at the closure, binds
    the receipt to the closing statement, which is what "the closure carries its
    OWN receipt" was always meant to say.

    **AND the closure arm binds each `status` to its own `resolution`, not
    merely to a non-NULL one** (#572's review round 24, finding 7). Both columns
    are unconstrained text in the delivered schema — `status String
    @default("open")` and `resolution String?`, the latter carrying only the
    comment `'reapproved' | 'withdrawn'; null on backfilled legacy rows`
    (`schema.prisma:2453`, `:2457`) — so "a complete set" admits a row whose two
    halves contradict each other. A receipt-holding writer reproduces an
    otherwise valid REAPPROVAL bundle — the revision, the event, the audit row,
    a truthful resolver pair, a real receipt — and stores `status = 'resolved'`
    with `resolution = 'withdrawn'`, or the inverse on a withdrawal; every arm
    passes, and the complete set is then immutable under the freeze while the
    row contradicts the transition, the event and the audit evidence it exists
    to corroborate. The delivered writers use exactly two pairs and the arm
    admits exactly those two: `('resolved', 'reapproved')` from the reapproval
    closure (`decisions.service.ts:492-494`) and `('withdrawn', 'withdrawn')`
    from `withdrawChange` (`:919-922`). `('open', NULL)` stays the only open
    shape, and the LEGACY allowance is explicit and narrow — a pre-4d row whose
    `resolution` is NULL is untouched, since those rows predate the seal and are
    the unprovable cohort this plan already names, but no NEW closure may write
    a NULL resolution. P33's evidence-freeze arms gain both CROSSED pairs, each
    REFUSED at commit with the decision's state unchanged, beside the two
    truthful pairs committing — RED against the both-present predicate, which
    admits all four.

    **The delivered writers already comply
    and this is checkable**: `requestChange` and the `returned` resolution's
    bundle insert an open row and supply no resolver column at all — the schema
    defaults every one of them to NULL — and the seed's DL-003 plant inserts
    `requestedById` alone, so this arm refuses nothing that runs today. Round 12 named this
    operation and then ADMITTED it, on obligations: a row born closed "carries a
    closure and owes what a closure owes". Naming an operation is only half the
    question; the other half is whether it is LEGAL AT ALL, and this one is not.
    No shipped command creates a closed request — both closures are UPDATEs of a
    row that was open — and a row born closed never passed through the sealed
    OPENING transition, because `ChangeRequest_t4d_paired` demands the
    same-transaction `approved → change` transition, its claimed event and its
    audit row for an OPEN `standard` request and never sees a row that was never
    open. So the round-12 arm let a receipt-holding writer manufacture permanent
    evidence of a request AND a closure that never occurred, with truthful
    actors and completed receipts, while the closure arm below stayed silent
    because the row never left `'open'` — it was never in it. **The CLOSURE
    arm**: whenever `status` LEAVES `'open'` — which is what a closure IS, for
    the withdrawal and the re-approval alike — the COMPLETE closure set of §A.3
    must be present in the same statement (`resolvedById`, `resolvedAt`,
    `resolution`, `resolvedByCommandId` and the frozen
    `resolvedByRole`/`resolvedByName` pair), all of it then immutable together
    exactly as the requester's is — **and, for a `standard` request closed to
    `withdrawn`, the resolver must BE the requester or hold `pmc` standing**
    (#572's review round 10, finding 1), while `open → withdrawn` on a
    `countersign_rejection` request is refused by ORIGIN before any authority is
    judged (round 11, finding 2).

    **This arm is keyed on the STATUS transition and NOT on `resolvedById`**
    (#572's review round 12, finding 1). Round 8 wrote it as *"whenever
    `resolvedById` goes from NULL to non-NULL"*, which is the closure only for
    a writer that sets the resolver — and the writer this whole plan models is
    the receipt-backed database-role writer that does not. Against it, `UPDATE
    "ChangeRequest" SET status = 'withdrawn', resolution = 'withdrawn'` with
    `resolvedById` left NULL is a complete, committed closure that the arm never
    fires on: no provenance is demanded, the origin prohibition round 11 placed
    INSIDE this arm is unreachable, and the decision is left in `change` with no
    open request — a state the service forbids and cannot recover, because
    re-approval requires exactly one open request to resolve. Keyed on `status`,
    the same statement is refused before any of it commits. The two DELIVERED
    closures are unaffected and this is checkable rather than asserted: both
    `decisions.service.ts:492` and `:919` already write `status`, `resolution`,
    `resolvedById` and `resolvedAt` in ONE `updateMany`, so an arm keyed on
    `status` sees exactly the statements an arm keyed on `resolvedById` saw.

    **The RE-OPEN arm**: `status` returning to `'open'` is refused outright. A
    closed request is closed; without this arm a hostile writer could reopen a
    resolved row and close it again with the resolver columns already non-NULL,
    and a second closure would escape an arm keyed on either column's
    transition — the same defect one operation further along. It also protects
    `ChangeRequest_one_open_per_decision`, which a reopen could contend against
    a legitimately open request. **The DELETE arm**: a `ChangeRequest` row is
    not deleted. Erasing an OPEN request strands its decision in `change`
    exactly as an unprovenanced closure does; erasing a CLOSED one destroys the
    provenance these arms exist to demand, permanently, on a row whose event and
    audit row are append-only — the doctrine `DecisionEvent_t4d_append_only` and
    `Notification_t4d_binding`'s DELETE refusal already state. The SANCTIONED
    RESET is the one admitted deletion: `prisma/seed.ts:100`'s
    `changeRequest.deleteMany()` and the fixtures' equivalent run inside the
    seed's existing `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …) … DISABLE
    TRIGGER` protocol under this seal's own name — one of the two names the
    DL-003 plant below already disables, so the reset learns NO new name, only
    a second site for one it already knows. No
    project-cascade arm is owed: `ChangeRequest` hangs off `Decision`, every
    decision write emits its `DomainEvent`, and `DomainEvent.tenant` is
    `onDelete: Restrict`, so a project holding a change request is not
    hard-deletable and no cascade ever reaches this table (#572's review round
    12, the DELETE sweep behind finding 5).

    **`open → withdrawn` is itself INVALID for a `countersign_rejection`
    request, whatever the resolver's authority** (#572's review round 11,
    finding 2). Round 10 added authority for the standard-origin case and
    asked nothing about the other origin on the same transition, and the
    closure/restoration pairing covers `standard` alone — so a database-role
    writer could reserve and complete a `decisions.withdrawChange` receipt,
    write a truthful complete resolver set, and withdraw an open
    `countersign_rejection` request while leaving its decision in `change`.
    That is a state the service forbids AND cannot recover from: reapproval
    requires exactly one open request, and this one closed without restoring
    anything. The arm therefore refuses the TRANSITION by origin before it
    judges any authority — the rejection request's only legal closures are the
    `resolved` its reapproval writes and the `returned` resolution's own
    bundle. P33 gains the hostile direct update: an `open →  withdrawn` on a
    `countersign_rejection` row carrying every provenance column correctly and
    a PMC resolver, REFUSED, with its decision still in `change` and its
    request still open (RED against the round-10 arm, which admits it). Round 8 gave this arm the
    closure's completeness and not its AUTHORITY, so a truthful closure by a
    stranger passed: every column right, every seal met, and a withdrawal the
    service forbids committed. The predicate reads
    `platform_user_holds_role(projectId, resolvedById, 'pmc')` over
    `ProjectUserStanding` under `phase6_try_readiness` — obligation 3's own
    register, so no orgs-owned function is called from a decisions seal, and
    the membership-less owner/admin `pmc` row counts exactly as it does for the
    requester arm (round 5, finding 3). The re-approval closure is NOT given
    this predicate: its authority is the approving act itself, which the
    revision's own birth seal already judges. Without that arm rounds 5 through
    7 specified a closure set that NOTHING enforced: a direct closure could set
    `resolvedById` alone, restore the decision and append its event, and meet
    every seal this plan installs — because the only seal on the table fires on
    a row a closure never inserts (#560's review round 2, finding
    1: the inventory named the receipt and not the pair, so the actor-id-only
    correspondence branch this unit is stated to close would have stayed
    open for a standard request), **with the seed's DL-003 plant rewritten
    in the SAME unit as its one NAMED bypass** (#564's review round 2,
    finding 1: `prisma/seed.ts` recreates the reopened decision's open
    request with `requestedById` alone — a pre-4d-shaped row in a seeded
    world that carries no events — and a normal post-migration seed would
    abort on this seal): the plant runs inside one `$transaction` that
    disables, by name, BOTH `ChangeRequest` seals the legacy-shaped row
    cannot satisfy — `ChangeRequest_t4d_provenance_required` (this unit's
    trailing seal) AND the permanent 4d-i pairing seal
    `ChangeRequest_t4d_paired`, which would otherwise refuse the bare open
    `standard` request at commit for lacking its same-transaction `approved
    → change` transition, claimed event and audit row (#568's review round
    2, finding 1: the seed creates DL-003 directly in `change` in an
    earlier transaction and inserts the request with no transition, event
    or audit row, so disabling the trailing seal alone left fresh AND
    mature post-4d-iii seeds aborting on the deferred trigger) — in the
    seed's existing `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …) …
    DISABLE TRIGGER` shape and re-enables both after; the complete opening
    bundle is deliberately NOT constructed (the seeded world carries no
    events, and a fabricated transition would be a fake fact), the two names
    are the CLOSED set (`DomainEvent_t4d_pairing_claimed` never fires
    because the plant inserts no event), and a pre-4d-iii database seeds
    unchanged; it is the ONLY admitted site under the statement tripwire
    (every other `changeRequest.create` in the repository is the service
    writer or an asserted hostile refusal), and P28b's reset arm runs the
    FULL seed on the post-4d-iii schema — a fresh database migrated through
    4d-iii, then a mature reseed — asserting it succeeds with every seal
    enabled afterwards and the planted request a legacy-shaped row, and
    that the same plant with ONLY the provenance seal disabled is refused at
    commit by `ChangeRequest_t4d_paired` (RED against the single-name
    bypass, #568's review round 2, finding 1), `Notification.eventId` AND
    `kind` required on every new row carrying a `decisionId`, and
    `approvedByName` AND `approvedByRole` required on every new
    `DecisionApprovalRevision`, and `DomainEvent.actorRole` AND `actorName`
    required on every new event of either kind (legacy and drain-window NULL
    rows untouched) — arms the
    feed-row arm of the no-chain approve's correspondence check (obligation
    7's last row), the `revisionId` payload field on every new
    `decision.approved`/`reapproved` event, the frozen
    `requestedByRole`/`requestedByName` pair on every new
    `DecisionConsultation` row and `respondedByRole`/`respondedByName` on
    every new response (#561's review round 2, finding 8), installs the
    THREE orgs-owned
    STANDING-WRITER seals — `Membership_t4d_readiness` on every `Membership`
    row write, `OrgMembership_t4d_readiness` on every owner/admin
    `OrgMembership` write trying `phase6_try_org_readiness` and then the
    org's project keys ascending, and `Project_t4d_org_readiness` on every
    `Project` insert trying the org key (§A.2 the push families — after the
    drain, so no legacy two-write path ever meets them), RETIRES the pre-4d-ii coverage
    version's rows in `ExternalEffectCatalog` by the gated `retiredAt` stamp
    (a tombstone, never a delete — an intent at the retired version refused
    from then on, and a 4d-i replay unable to resurrect it), takes the
    `decisions.effects` catalog row `FOR UPDATE` and, **ON THE INITIAL RUN ONLY
    — that is, with the `RolloutRetirement` marker ABSENT** — reads the
    activation head and, if the consumer is not active, APPENDS its activation
    at `activationSeq + 1` under the gate, then VERIFIES in the same transaction
    that the head is active, aborting the whole retirement with every door
    intact otherwise (#561's review round 2, finding 3: a fixed-sequence `ON
    CONFLICT DO NOTHING` insert could be skipped by an operator
    activation-then-deactivation that consumed the sequence, retiring the doors
    with the consumer inactive; the next relay pass expands the consumer's whole
    history per the persisted rule — the P38 activation arm).

    **A marker-PRESENT replay neither appends nor requires an active head**
    (#572's review round 24, finding 6). Once this stage has run, an operator may
    legitimately deactivate `decisions.effects` — that is what the register and
    its protocol exist for. The earlier wording made the next `ALWAYS_EXECUTE`
    replay see the inactive mirror and attempt a migration activation again, and
    the companion document's retry identity turns that into a choice between two
    failures: reusing the migration's fixed token collides on `(consumer,
    actorKind, requestToken)` and ABORTS the deployment, while minting a fresh
    token silently overrides a later operator's intent — precisely the replay
    defect that document's own round-1 finding 2 exists to prevent. The closing
    verification compounds it, since the head is inactive because someone
    decided it should be. So the marker decides: absent, this is the first
    retirement and the activation is part of it; present, the retirement already
    happened, the activation is already an attributable fact in the register,
    and the replay asserts only that the fact EXISTS — never that the current
    head is active. This is the same marker, read the same way, as the
    reservation doors and the marker-aware `CREATE OR REPLACE` statements above,
    and it is the third question the retirement asks of it. P38's activation arm
    gains the replay over a deliberately deactivated consumer: the migration
    re-run COMMITTING with nothing appended, no token reused, and the operator's
    deactivation still standing — RED against the unconditional branch, which
    aborts the deploy, and writes the sealed `RolloutRetirement` marker (`INSERT … ON
    CONFLICT (unit) DO NOTHING` under the `SET LOCAL` gate, so a later
    `ALWAYS_EXECUTE` replay over the immutable row neither aborts nor
    rewrites it, the closing verification requiring the row to EXIST);
    re-runnable — every replay re-drops ALL SIX reservation triggers
    (`Decision_t4d_architect_reserved`, `Decision_t4d_awaiting_reserved`,
    `Membership_t4d_architect_reserved`, `User_t4d_architect_reserved`,
    `DecisionForward_t4d_reserved`, `DecisionEvent_t4d_kind_reserved` —
    #582's review round 15, finding 2: the audit register's four 4d-only
    KINDS were the one member of the reserved set the reservation had never
    covered, and this list is the reason a sixth door is cheaper than a
    special case) AND their shared
    function `IF EXISTS` and then CHECKS the retirement complete exactly as
    4c-v's closing block does, raising if a trigger or the function remains —
    in `ALWAYS_EXECUTE` after 4d-i, with the mirror probes (P28b; the
    old-write-shape inserts of P42 now refused) and the proof's before/after
    structure exactly as 4c-v did for 4c-iii's seal. There is NO backfill
    (chain activation is a per-project product act by the PMC, never a
    database default) and NO preservation seal, so 4d has no analogue of
    4c-iii/4c-iv and no third gate: 4d-iii carries no rollout prerequisite of
    its own — an architect membership is written only by the new release, and
    once the old release is drained there is no reader that can be surprised
    by it. **4d is complete when 4d-iii merges**, and the §E handoff to the
    remaining decision-workflow scope (the master plan's post-4d items, none
    of which is authorized by this plan) follows it.

- **Deferred dependencies, named**: the frozen-audience `targetUserIds` is
  a platform `DispatchInput` extension shipped IN 4d-ii beside the families
  that use it (no unit depends on it earlier); `platform_tx_event`,
  `RoleStandingQuery` and `EventStreamQuery.latestPosition` are kernel
  primitives shipped in 4d-i (the SQL) and 4d-ii (the TypeScript queries),
  each registered on the platform manifest; no 4d unit depends on any
  contractor-capture unit, on the P3005 correction in the maintenance
  queue, or on any saved UX or performance work, and none of those is
  started by 4d.

- **Not in 4d, stated so the review can hold the line**: no rename (`room`
  → `space`), no external collaboration, no change to approval history (the
  register stays append-only in every respect but the one paired `finalized`
  flip), no UX or performance work beyond the surfaces §A.2 names, no
  contractor-capture unit (units 1–6 stay Board-gated), no automated drain
  actor, no repair engine, no PL/pgSQL emitter.

## What carries forward

- The binding ledgers of `docs/reviews/pr-335-convergence.md` and
  `docs/reviews/pr-340-convergence.md` — every decision above is carried from
  them, none reopened; and the sixteen closed PRs #537–#552 with their review
  threads, the record of every finding §A.4 answers.
- 4a's delivered seal network, audience rule, cancellation spine and
  linkability authority; 4b's delivered decider model, targeted push spine,
  §B.1/§B.2 primitives, holder freeze and orphan guards; 4c's delivered
  consultation register, the try-readiness protocol as a primitive, the
  command-provenance shape, the per-family push predicates and their
  archived-project rule, and the dark-migration → drain → enable rollout
  discipline — extended by reference, never rewritten.
- The rule this plan adds to the contract, for every unit after it: a seal
  verifies the bundle a writer must produce; it never produces the bundle
  for the writer.
- The owner's recorded intent: decisions decided by the right party, issues
  filed without ceremony, consultation that informs without gating, and an
  architect who countersigns without becoming a bottleneck nobody can route
  around.
