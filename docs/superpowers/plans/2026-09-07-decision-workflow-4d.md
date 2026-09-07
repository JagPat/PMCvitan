# Decision workflow, unit 4d — the architect, forwarding and countersign: the plan

**Status: PLANNING — this is the docs-only 4d plan unit the merged 4b plan's
§E order requires** (`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`
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

This document REPLACES PR #565 (`Replaces: #565` — labelled
`review-replacement-required` by the orchestrator before it closed, so the
ledger holds its obligation; every predecessor closed at the limit stays a
labelled pending obligation until a MERGED unit names it, one merge
discharging one — the accepted gap of
`docs/reviews/replacement-lineage-repair.md`; #541 alone holds no label,
having closed before it could be labelled). #565 was the ELEVENTH outing
of the NARROWED plan: it drew three findings on its first head (`5871826`;
two folded on its one correction `89bd230`, one — the drain attestation —
declined on the Board's recorded decision) and one more on that head, and
closed at the limit. #565 had replaced #564 (the tenth outing: one on
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
| 6 (P2) the fact's actor-authority check accepted the captured pre-state only as `pmc`/`active` for a self-transition, so an org owner/admin re-roling or adding themselves would pass the service and fail the seal | §A.2 the membership paragraph; P29b | the owner/admin arm is judged LIVE for every transition, self-targeted included (a project membership write does not change org standing); the captured PMC pre-state is the self-demotion arm only |
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
| 3 (P1) the `(projectId, eventId)` key proved the feed row and the event share a project, not that the event is ABOUT the row's decision — a notice for decision A could bind B's event and render B's content under A's visibility | §A.3 obligation 7 (the feed row); §D 4d-i; P31 | `Notification_t4d_binding` gains an INSERT arm on the platform's own two tables: a kinded row carrying `decisionId` binds only an event whose `entityType = 'Decision'` and `entityId = decisionId` — identity columns compared, no decision semantics in the platform |
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
| 2 (P1) the architect's `ROLE_POLICY` set was "every entry the role belongs in", named only in part, with the route walk pinning whatever the implementation chose | §A.1; P28 | the EXACT twelve-action set is stated (three reads, five delivered decision actions, `consultation.request`, `decision.forward`/`countersign`/`disagree`), the exclusions named, and P28 asserts equality over every `ROLE_POLICY` action |
| 3 (P1) the §A.3 table left `DecisionConsultation` and its response with service-emitted, unsealed effects, so a hand-run consultation committed without its event | §A.3 obligation 7 (the converse); §D 4d-i; P37 | both facts require their same-transaction event naming the consultation and the converse refuses the event without its fact, sealed in 4d-i (the delivered service already emits both in-transaction) |
| 4 (P1) `cancelledAt` was left freely mutable, so a direct writer could suppress a leased push or un-cancel a stale one | §A.3 obligation 7 (the delivery seal); P37 | `OutboxDelivery_t4d_frozen` admits `cancelledAt` only as the NULL → timestamp write of the mark's own statement or the delivered leased/dead mark-only arm, never cleared or rewritten |
| 5 (P1) the activation register's per-consumer sequence had no lock-before-append protocol; two appends could commit seq 2 then seq 1 and leave the mirror at the older fact | §A.3 obligation 7 (the delivery seal); P38 | the BEFORE INSERT takes the catalog row `FOR UPDATE` and requires `seq = activationSeq + 1`; the AFTER INSERT advances `active` and `activationSeq` together; the loser is refused with a stale sequence |
| 6 (P2) `SnapshotService.shellSummary` counts `status === 'pending'` itself and never calls `countPending`, so the nav badge would read zero for an architect's awaiting obligation P31 asserts | §A.1 the readers; P31 | the shell badge is served by the SAME `countPending`; P31 asserts the badge for the architect's awaiting decision and the PMC's stranded one |
| 7 (P1) a `ProjectEventStream` row could be deleted and reinserted at `N + 2`, bypassing the `+1` seal and leaving position N absent forever | §A.3 obligation 7 (the kernel envelope); §D 4d-i; P37 | DELETE refused outside the project-deletion cascade, INSERT admitted only at `nextPosition = 0` for a project without events, `ProjectEventStream_t4d_no_truncate` in `TRUNCATE_SEALS` (now FOURTEEN) |

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
consultation chooser needs) and `companies.read`; the five delivered
decision actions the architect performs as HOLDER or consultee,
`decision.approve`, `decision.updateDraft`, `decision.change`,
`decision.withdrawChange` and `consultation.respond`;
`consultation.request`, because the architect joins the requester set; and
three of the four NEW 4d actions of §A.2 — `decision.forward` (its row
lists every role that can hold a decision, the forward door judging
holder-ness), `decision.countersign` and `decision.disagree` (`architect`
only). TWELVE actions, no other. Deliberately NOT: `decision.create`,
`decision.publish` and `decision.withdraw` (issuing and withdrawing stay
the PMC's), `decision.resolveStrandedCountersign` (`pmc` only), `org.create`,
and every requirement, procurement, stock, labour, commercial, activity,
inspection, daily-log, media and drawing action — the architect's authority
is the decision workflow and nothing adjacent. P28's `route-policy.test.ts`
arm asserts EQUALITY: for every action in `ROLE_POLICY`, `architect` is in
its role list iff the action is one of the twelve, so an accidental widening
onto a commercial or payment action and an omitted read both fail the pin. **The EXISTING targeted catalog entries
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
creates the member). P29c probes the five doors in both states: with the
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
and whose `toDesignation` EQUALS the NEW ones, and the two DIFFER (the
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
status-gated**: forwarding is legal only in states the NEW HOLDER can act on
— `pending` and `change`, CAS'd on status at the command AND required by both
DB doors; terminal states refuse; `awaiting_countersign` is EXCLUDED from
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
EXPLICIT gated writer arm of the seal — `INSERT … ON CONFLICT DO NOTHING`
under `SET LOCAL vitan.phase6_4d_standing_backfill = 'on'`, the seal
admitting a depth-1 write ONLY under that gate and ONLY as a zero-count
insert for a project that has no row — so every `ALWAYS_EXECUTE` replay
re-runs the backfill for a project created since (a project without an
architect membership has no row until its first standing write) and
commits, while the same statement outside the gate is refused (#560's
review round 2, finding 5: the depth-only seal would have refused the
replay's own insert and made 4d-i unreplayable);
`upgrade-proof.sh` asserts register = count over the legacy fixture, P29b
asserts it after EVERY transition shape (insert, activate, soft-remove,
restore, re-role in and out, through the service; the project cascade), and
an operator `platform:verify` diagnostic compares the two OFFLINE, never in a
transaction. **Per-user standing and identity live in the kernel the same
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
report. **The repair is taken behind a table fence, not behind the org
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

**The membership write that flips architect standing is a LEDGERED
TRANSITION with an immutable fact and an EMITTED event — demanded of every
writer, produced by none but the service.** The orgs-owned
`MembershipTransition(id, projectId, membershipId, fromRole, fromStatus,
toRole, toStatus, actorId, actorRole, actorName, sourceCommandId NOT NULL,
at)` fact — the frozen `actorRole`/`actorName` pair being obligation 3's
instance for the one orgs fact (#554's review round 1, finding 4): the
role THIS actor holds at the act — the actor's ACTUAL token role, judged per
user by `platform_user_holds_role(project, actor, actorRole)` (a
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
`DEFERRABLE INITIALLY DEFERRED` (on `members.add` the fact is inserted BEFORE
the membership row it names exists — the service preallocates both ids — so
the check holds at commit), a same-project composite FK to
`CommandExecution(projectId, id)` (immediate — the receipt is reserved before
the fact), the `(projectId, sourceCommandId)` one-use UNIQUE, EVERY column
immutable (append-only + `MembershipTransition_t4d_no_truncate`, in
`TRUNCATE_SEALS`), registered in `orgsManifest.ownsModels`/`readEncapsulated`.
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
arm is read live for any membership other than the actor's own, and for the
actor's OWN membership (a self-transition `updateRole` permits — the
self-demotion case) it is the fact's captured pre-state, `fromRole = 'pmc' AND
fromStatus = 'active'`, since the row's post-state is what the write just
made it; a self-ADD (no prior row) is admitted by the owner/admin arm alone —
so a fact whose `actorId` satisfies neither arm is refused, and an owner/admin
with an active architect membership re-roling or adding themselves passes
the seal exactly as they pass the service; paired with
the DEFERRED, TABLE-SPECIFIC `phase6_t4d_membership_transition_bound`
requiring at commit that the cited command SUCCEEDED naming
`NEW."membershipId"` as its result (the delivered `phase6_t4c_provenance_bound`
binds `resultRef = NEW.id`, which here would be the fact's own id) AND that a
same-transaction `Membership` write matching the fact exists (an orphan fact
refused). A hard DELETE of a row whose OLD role is `architect` is refused
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
round 2, finding 1). **AND the crossing-capable write
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
'architect')` at commit (one flip per project per transaction makes that
equality exact), and refuses the write otherwise — the WHOLE event bound,
because `decisions.effects` below decides whether a crossing happened from
`role` and `to`, and a bundle that cited the real fact with `role:
'engineer'` or a non-active `to` would commit, be recorded `noop`, and leave
the newly active architect without the re-notification the fact owes (#555's
review round 2, finding 2). **And the pairing holds in the CONVERSE
direction**: the orgs-owned DEFERRED constraint trigger
`DomainEvent_t4d_standing_event_paired` on the kernel's `DomainEvent`, `WHEN
(NEW."eventType" = 'membership.standing_changed')`, requires at commit
exactly one same-transaction `MembershipTransition` row of the event's
project whose id is the payload's `transitionId` and whose `membershipId` is
the event's `entityId`, so a standalone catalog-valid crossing event with no
fact — a fabricated re-notification — is refused; the trigger reads only the
orgs-owned fact table and the row it is handed, the delivered shape of
`phase6_t4b2_membership_guard` (a decisions-owned trigger on the orgs-owned
`Membership` that reads only `Decision`), and obligation 7 states the same
converse for every sealed decision event type. The three orgs membership
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
key, the §A command-level readiness-lock enumeration gaining all three. They
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
succeeds with no delta and no register row left, AND hard-deletes a project
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
touches `pending`. **A DEPARTED holder is re-homed atomically**: `returned`
for a decision whose named holder has left (the exemption below) REQUIRES a
same-command `toDesignation` and the resolution bundle carries a
`DecisionForward` row from the departed holder to the named ACTIVE target,
actor the resolving PMC, reason the resolution's, so the decision lands in
`change` with an active holder and never trips the orphan guard; a
`returned` without a target for a departed holder is 400; the bundle-aware
provenance binds the third fact to the same receipt. Probed end to end in
P29b: both outcomes, the refusal while an architect is still active, the
architect-reappears race, the missing-request hostile bundle, the departed
holder's re-homing.

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
refuses an approval event there). **The readers
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
`phase6_t4c_consultation_response_seal` — `CREATE OR REPLACE` in 4d-i, the
bodies otherwise byte-identical — the request seal's requester arm moving
from `phase6_user_decision_authority` to
`platform_user_orchestration_authority`), so an architect may consult on the
very approval they must countersign. **The RESPONSE push follows the widened
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
request-time role. The cycle
semantics need no new rule: a consultation requested while awaiting freezes
`openCycle` at the count that INCLUDES the provisional approval; the
countersign appends NO revision (finality is a flip on the existing head),
so such a consultation stays cycle-valid until the decision leaves the open
set; a later re-approval appends the next revision and closes the cycle
exactly as 4c's P25d proves.

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
and only under an ACTIVE chain — and a DEFERRED pairing requires at commit
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
`countersign-v1` — the web gateway declares it on EVERY request that reaches
the API, `req()` AND the direct `fetch('/auth/session')` in
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
`awaiting_countersign` with a DEPARTED holder whose only exits are the
stranded resolution's two outcomes. A named holder who is an architect but
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
   evidence, and no separate label is recorded or demanded) — AND its
   frozen `<act>ByName` must equal the account's display name read by the
   kernel's `platform_user_display_name(userId)` over the `UserIdentity`
   register at the act (the fact is written in the act's transaction, so
   "at the act" and "at commit" are the same instant); a supplied role the
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
   the receipt's `actorId` to the row's recorded actor. **Extended for
   BUNDLES**: the delivered `phase6_t4c_provenance_bound` requires the
   receipt's `resultRef` to name the row itself, which a command writing ONE
   fact satisfies and a command writing a bundle (forward-on: request +
   forward; the stranded return: resolution + request, + the departed
   holder's forward) cannot. The 4d-owned `phase6_t4d_provenance_bound`
   accepts a `resultRef` naming the row OR the bundle's PRIMARY fact when the
   same transaction pairs them and both cite the SAME receipt — the primary
   is the reject-back/forward-on REQUEST for `decisions.disagree` and the
   RESOLUTION row for `resolveStrandedCountersign`; the per-table one-use
   UNIQUE still holds. `ChangeRequest` joins the contract — and it carries no
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
   evidence, never the command's response). A NULL stays admissible on
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
   DARK in 4d-i and nothing writes them until the service unit — and NULL
   is admitted ONLY on the no-chain approve's event through the drain, since
   the pre-4d-ii `emitEvent` writes neither; the trailing 4d-iii seal then requires the pair on every
   new event of EITHER kind — a `systemActor` carries a constant name and
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
   4d-iii makes a NULL pair unrepresentable on new rows — P42's arm drives a
   pre-4d-ii-shaped approval through the 4d-i seals and asserts it commits,
   then the same shape after 4d-iii and asserts it is refused); and, for a
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
   never recorded): the decisions-owned DEFERRED constraint trigger
   `DomainEvent_t4d_decision_event_paired` on the kernel's `DomainEvent`,
   `WHEN (NEW."eventType" IN (…))` over exactly the types the table below
   lists — the two DELIVERED consultation types included, since the uniform
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
   or requester received nothing) — and the converse refuses the event
   without its fact
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
   crossing and transition; the decisions-owned partial UNIQUE index on
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
   `withdrawChange` does all three under the readiness lock). **And the
   closure and the restoration are one bundle in BOTH directions** (#558's
   review round 1, finding 2: requiring the closure alone let a direct
   transaction close the sole open request, append the audit row and the
   event, and leave the decision in `change` — stranded, with nothing to
   withdraw and no state to approve from): a decisions-owned DEFERRED
   trigger on `ChangeRequest` requires, for a `standard` request written to
   `withdrawn`, the same-transaction `Decision` row (own table, `xmin`
   current) landed `approved` and the same-transaction
   `decision.change_withdrawn` event through `platform_tx_event`; the
   approved-entry seal's restoration arm already requires the
   same-transaction closure; neither half commits without the other. **And
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
   are written ONLY by the versioned catalog-data migration under the `SET
   LOCAL` gate (4d-ii's migration writes each consumer's rule beside its
   `catalogVersion`), frozen by `OutboxConsumerCatalog_t4d_rules` (UPDATE
   of the rule columns refused outside the gate), and `syncConsumerCatalog`
   VERIFIES at startup that the persisted rule equals the compiled contract
   — refusing the process on drift exactly as it refuses a `catalogVersion`
   mismatch today — and never writes it. **The obligation set is the ACTIVE
   set, judged from an append-only fact — never a timestamp** (#560's
   review round 1, findings 1 and 2: `registeredAt` as the cutoff was a
   plain writable column, so a direct writer could move it past the event
   and commit without the consumer's row; and a consumer set inactive for
   event N and reactivated for N + 1 would have had N excluded from
   expansion "because it postdates registration", stalling its ordered
   cursor at N forever): `OutboxConsumerCatalog.active` becomes the MIRROR
   of the platform-owned append-only, attributable
   `OutboxConsumerActivation(consumer, seq, active, reason, actorKind,
   actorId, at)` register — its rows written under the `SET LOCAL` gate by a
   migration (4d-ii registers `decisions.effects` INACTIVE; 4d-iii appends
   its activation after the drain) or by the operator `outbox:consumer`
   command through the ledger, `seq` monotone per consumer, `reason` NOT
   NULL under the `DecisionForward.reason` discipline (zod trims and
   requires length ≥ 1; the CHECK rejects a value that is empty once every
   ASCII whitespace character is stripped — #560's review round 2, finding
   4), UPDATE and DELETE refused AND the statement-level
   `OutboxConsumerActivation_t4d_no_truncate` registered in `TRUNCATE_SEALS`
   while the table stays outside every sanctioned reset (#560's review round
   2, finding 2: a direct `TRUNCATE` would have erased the evidence and left
   the mirror unexplained) — whose BEFORE INSERT trigger takes the
   consumer's `OutboxConsumerCatalog` row `FOR UPDATE` and requires
   `NEW.seq = activationSeq + 1` against the stored head, and whose AFTER
   INSERT trigger — the ONLY writer of the mirror — advances `active` and
   `activationSeq` together (#561's review round 1, finding 5: without the
   head lock two operator appends could commit seq 2 then seq 1 and leave
   the mirror at the OLDER fact; now they serialize on the catalog row and
   the loser is refused with a stale sequence, never reordered); `OutboxConsumerCatalog_t4d_rules` freezes `active` and
   `registeredAt` beside the rule columns, so the only way to exclude a
   consumer from an event's obligation is to append an attributable
   deactivation row that survives as evidence, and `registeredAt` plays no
   part in any seal. `expandMissingDeliveries` keeps its DELIVERED contract
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
   `deliveryRowsFor` reads the catalog rows `FOR SHARE` and the event's
   transaction holds those locks to commit, so an activation append — which
   takes the row `FOR UPDATE` — either committed before the obligation set
   was read or waits for the event's commit, and the deferred seal re-reads
   under the same locks (#561's review round 2, finding 5: an unlocked read
   let an activation commit between the event's check and its commit,
   leaving an event with no row for a consumer active at its commit — the
   exact window the seal exists to close); P38's barrier probes
   event-vs-activation in both orderings;
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
   pushBody)` — the last three the push-shape evidence the envelope and
   transition seals below read, seeded from the compiled `EXTERNAL_EFFECTS`
   entries like every other column and under the same tripwire (#560's
   review round 1, finding 3: the enumerated schema omitted them while the
   next paragraph read them) — primary key `(coverageVersion,
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
   implementation, so service and seal resolve the same set; an empty set is
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
   AND the converse `DomainEvent_t4d_decision_event_paired` (and, from
   4d-ii, `DomainEvent_t4d_deliveries`) by name inside its plant transaction
   and re-enables them after, an explicit bypass the reader can see, never
   an implicit hole — the FULL set, because a plant of a paired type with no
   fact is refused by the converse even when the envelope admits it (#560's
   review round 1, finding 11); and the sweep's standalone
   `decision.approved` plants that exist to probe the OUTBOX —
   `outbox.test.ts`'s relay, rollback and seal cases, which carry no
   approval revision — move to a family the converse table does not pair
   (`decision.published`, an announcement with no transition fact), keeping
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
   4d-i installs `DecisionEvent_t4d_append_only`, a BEFORE UPDATE OR DELETE
   trigger refusing every UPDATE and DELETE on the register (no service path
   mutates a `DecisionEvent` — the writer sweep pins it); the register is
   then append-only in every respect, its legacy `actor` label rows
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
   not a shared DECISION, so `Notification_t4d_binding` also carries an
   INSERT arm on the platform's own two tables — a kinded row carrying
   `decisionId` binds only an event whose `entityType = 'Decision'` and
   `entityId = NEW."decisionId"`, identity columns compared with no decision
   semantics in the platform (#558's review round 1, finding 3: with
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
   carrying a `decisionId`. And for a row carrying `kind`, EVERY reader —
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
   UPDATE OR DELETE trigger, refuses on any row whose `eventId` is non-NULL a
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

   | transition | event (`DomainEvent.eventType`) | audit (`DecisionEvent.type`) | feed row | actor bound to (id, frozen role AND name, on event, audit row and fact) | armed |
   |---|---|---|---|---|---|
   | `pending`/`change → awaiting_countersign` (the provisional approve) | `decision.awaiting_countersign` — the ONE event of this transition (payload: the provisional act; intent: the countersign demand with the architects frozen as `targetUserIds`); a `decision.approved`/`reapproved` at this transition is REFUSED (finality is the finalizer's row) | `approved` / `reapproved` (the act happened and is attributable) | the provisional notice, `kind = 'decision.awaiting_countersign'` | the head revision's `approvedById` | 4d-i (no pre-4d writer can reach the state) |
   | `awaiting_countersign → approved` by countersign | `decision.approved` / `decision.reapproved` by the revision's `approvedFrom` | `countersigned` | the green approved notice | `countersignedById` | 4d-i |
   | `awaiting_countersign → approved` by `completed` resolution | the same, by `approvedFrom` | `stranded_resolved` | the green approved notice | `resolvedById` | 4d-i |
   | `awaiting_countersign → change` by disagreement (reject-back or forward-on) | `decision.change_requested` | `change_requested` | the change-request notice | `requestedById` | 4d-i |
   | `awaiting_countersign → change` by `returned` resolution | `decision.change_requested` | `stranded_resolved` + `change_requested` | the change-request notice | `resolvedById` = `requestedById` | 4d-i |
   | the holder mutation (forward, generic or forward-on) | `decision.forwarded` | `forwarded` | the forward notice | `forwardedById` | 4d-i |
   | `pending`/`change → approved` with NO chain (the direct approve) | `decision.approved` / `decision.reapproved` | `approved` / `reapproved` | the green approved notice | the head revision's `approvedById` | event + audit row from 4d-i (the delivered `approve` writes both in-transaction, so the previous release is compatible through the drain); the feed row's `eventId` binding from 4d-iii, since the previous release writes the row without it |
   | `change → approved` by standard `withdrawChange` | `decision.change_withdrawn` | `change_withdrawn` | — (the delivered path writes none) | the receipt's actor | event + audit row from 4d-i (delivered, in-transaction) |
   | the architect standing flip on `Membership` | `membership.standing_changed` naming the fact — payload `transitionId`, `membershipId`, `role`, `from`, `to`, `activeCount` ALL bound to the fact and the register; paired in the CONVERSE by `DomainEvent_t4d_standing_event_paired` | — (orgs; the fact is the audit) | — | the fact's `actorId` and frozen `actorRole`/`actorName`, on the event envelope | 4d-i (no pre-4d writer can flip the role) |

   A `DecisionEvent` written by the service for a transition this table does
   not list (the delivered `issued`, `drafted`, `draft_updated`,
   `change_withdrawn` on other paths) is untouched; the seal judges only the
   transitions it admits.

The closed enumeration over every fact these units add:

| fact | pairing (2) | actor standing (3) | subject eligibility (4) | provenance (6) | effect (7) | probes |
|---|---|---|---|---|---|---|
| `Decision` holder columns (4b) | the forward door, from 4d | named decider membership ACTIVE at create/holder-write | the kind⟺status CHECKs; the delivered orphan guard, open set widened to `awaiting_countersign` | — (the decision row's own commands are ledgered) | `decision.forwarded` on the holder mutation | P17/P18/P34/P39 |
| `DecisionConsultation` (4c) | — | `requestedById` ACTIVE pmc **+ architect (4d)**; consultee ACTIVE at insert; frozen requester role + name judged (4d) | open (`pending`/`change` **+ `awaiting_countersign` (4d)**) AND published | delivered | `decision.consultation_requested` naming the consultation — SEALED in 4d-i in both directions (#561's review round 1, finding 3) | P25/P27/P37 |
| `DecisionConsultationResponse` (4c) | — (UNIQUE per consultation) | responder is the named consultee; frozen responder role + name judged (4d) | the same predicate re-judged at response, cycle-frozen | delivered | `decision.consultation_responded` naming the consultation — SEALED in 4d-i in both directions (#561's review round 1, finding 3) | P23/P25/P27/P37 |
| `DecisionForward` (4d) | holder mutation ⟷ row | `forwardedById` = holder-user / pmc / architect, ACTIVE; frozen role + name judged | `pending`/`change` only; `awaiting_countersign` ONLY with the same-tx `countersign_rejection` request | required | `decision.forwarded` + `forwarded` + notice | P34 |
| `DecisionCountersign` (4d) | finality flip + `awaiting → approved` ⟷ row | `countersignedById` ACTIVE architect; frozen role + name judged | `awaiting_countersign` only | required | the finalizing event + `countersigned` + the green notice | P31 |
| `DecisionStrandedResolution` (4d) | outcome BUNDLE ⟷ row | `resolvedById` pmc; frozen role + name judged; non-blank reason | `awaiting_countersign` AND no active architect | required | per outcome, the table above | P29b |
| `DecisionApprovalRevision` finality (4d) | birth value by chain presence; flip only by paired fact; one row per approval transition | carried by the pairing facts; `approvedByRole`/`approvedByName` judged when present | the approved-entry seal | delivered (4c) | the awaiting entry's and the direct approve's rows | P31/P37/P42 |
| `ChangeRequest` origin (4d) | `countersign_rejection` ⟷ the exact `awaiting_countersign → change` transition, AND with its producer's fact (P33b) | `requestedById` ACTIVE architect under an ACTIVE chain, or the resolving pmc; frozen role + name judged | the awaiting subject | REQUIRED for `countersign_rejection`; admissible NULL on `'standard'` rows only until 4d-iii | `decision.change_requested` + `change_requested` + notice | P29b/P33/P33b |
| `MembershipTransition` (4d, orgs) | the architect standing write ⟷ row; one flip per membership and per project per transaction | `actorId` holds team-management authority (the owner/admin arm live; the project-PMC arm live, or the captured pre-state for a self-demotion); frozen `actorRole`/`actorName` judged | — | required (`phase6_t4d_membership_transition_bound`) | `membership.standing_changed` naming the fact — `role`, `membershipId`, `from`, `to`, `transitionId`, `activeCount` and the envelope pair all equal to the fact and the register — and paired in the converse | P29b |

A future fact table added under these units inherits this contract by
default: omitting an obligation is a defect by construction, and each unit's
review packet walks this table for every fact it ships. The unit writes only
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
five reservation doors installed before the enum values; the `Membership`
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
   chain, → `awaiting_countersign` under a chain) whose recorded actor holds
   decider standing for the decision's CURRENT holder designation, WITH its
   effects (obligation 7) — and the REVERSE: every transition INTO
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
| P28 | the role in every mirror: `TokenRole`, both zod enums, `PushRole`, `KNOWN_ROLES`, the manifest permissions, `ROLE_POLICY` (the exact row set), the schema comment, the web role lists and pickers; the DESIGNATION in every mirror (`DeciderKind`, `DECIDER_KINDS`, the shared type, `viewerIsDecider`, `deciderNoun`, the picker, the audience selectors, the `deciderPush` architect arm and the `deciderPushTarget` arm — a published architect-designated decision's RECIPIENTS are every active architect's links and no client link, RED at base where the fallthrough targets `client`); the widened targeted-catalog ceilings; `countPending`'s architect and awaiting arms; a decision published to an architect holder and a consultation requested from an architect end to end; **P28b** the dark delivery — the five reservation doors (the `User` door installed under the `User` table lock before the audit), the `Membership`/`User` audits barrier-probed in both orderings on the shipped file — the `User` writer too (writer-first → ABORT; migration-first → REFUSED), the abort → re-role → `migrate resolve --rolled-back` → redeploy recovery driven through the REAL runner for an active row, `ensure-accounts` refusing an `ACCOUNTS_JSON` with an `architect` entry before any row is written (no `User`, no `Membership`) while the `pmc`-only file provisions and the `AUTO_ENSURE_ACCOUNTS=true` boot over the refused file fails closed naming the entry, a soft-removed row and a dev `User` fixture, the service refusals BEFORE any write (an architect added by a NEW email while reserved → 409 and ZERO `User` rows; after 4d-iii the member is created), the dev session refusing `architect` before either branch while reserved and the synthetic fallback never minting it, and the `ALWAYS_EXECUTE` replay arms — a post-4d-iii database holding an active architect replays 4d-i, finds the marker, installs no door and no refusal function, aborts nothing; a pre-4d-iii database still installs and audits; the `ROLE_POLICY` EQUALITY pin — `architect` in an action's role list iff the action is one of the twelve, a widening onto any commercial or payment action and an omitted read both RED | the role vocabulary, the designation contract, the reservation, the audit, the runner |
| P29 | no-active-architect byte-identity: with no architect membership ever, approve lands `approved` directly with `finalized = true`, forward works for holder/PMC and is refused for the missing role's authority, `countersignRequired` is absent, a `standard` origin is omitted, the whole 4b/4c surface is byte-identical (the wire-shape tripwire); **P29c** mixed-version byte-identity — with the reservation ARMED every project is chain-off, no row can be `awaiting_countersign`, no membership can be `architect`, no `DecisionForward` row, `decision.forwarded` delivery or architect-designated row (draft or published) can exist, no Forward renders, every read a pre-4d instance performs sees only values its enums know; and the STALE-CLIENT arms — every strip / refuse / additive-ignorable classification of the completeness tripwire exercised for `recorded-v1` and `countersign-v1`, the activation-between-check-and-approve barrier in both orderings, an architect signing in through EACH token-minting route refused for the lesser client and served for the newer, after 4d-iii | the whole 4b/4c surface; the interceptor; the four in-command contract checks |
| P29b | removed-architect deactivation + the stranded decision: the chain deactivates for NEW approvals; `decisions.resolveStrandedCountersign` drives BOTH outcomes with their bundles and their effects (the `completed` outcome emitting by `approvedFrom`; the `returned` bundle's request authored by the resolving PMC and admitted by P33b; the returned-resolution bundle MISSING its request refused; a whitespace-only reason refused at zod AND the CHECK); the bare hostile awaiting flip under the INACTIVE chain refused without the fact; refused while an architect is still active; the architect-reappears race deterministic; the departed-holder `returned` with a target re-homing into `change` with the forward fact, without one refused; the RE-NOTIFICATION — approve → A removed → B added, exactly one new `decision.awaiting_countersign` delivery per still-awaiting decision, B and only B receives it, the `countersign_renotified` audit row naming the crossing event and the transition; the HAND-RUN sequence — A removed and B added by receipt-backed direct bundles carrying their events: the same one delivery and the same audit row; A-active/B-added: no crossing, nothing re-emitted, B's Inbox item present; the register after EVERY transition shape, written only through `platform_role_standing_apply` from the orgs-owned trigger (a direct call at statement depth refused; a direct write refused); the crossing event on every architect activation/deactivation and the second session's tab refreshing its modal copy; the ineligible-actor fact refused; a fact whose `actorRole` the actor does not hold, or whose `actorName` is not the account's, refused, and the pair frozen against a later rename or re-role; an org owner/admin with an active architect membership re-roling and adding THEMSELVES through the service accepted by the seal (the owner/admin arm live), a PMC's self-demotion accepted on the captured pre-state, a contractor's self-transition refused; every direct-write refusal of §A.2's membership paragraph — the whole-event binding arms (`role: 'engineer'`, a non-active `to`, a `from` or `membershipId` not the fact's, an envelope pair not the fact's) each refused at commit and the standalone crossing event with no fact refused by the converse trigger, with `decisions.effects` asserted to record NO delivery for any of them; the cascade probes; the backfill REPLAY — 4d-i re-run over a database holding a project created since, without an architect, inserting that project's zero row under the gate and committing, the same insert outside the gate refused; the per-user registers — `ProjectUserStanding` and `UserIdentity` equal to the orgs truth after every membership shape (activate, deactivate, remove, restore, re-role in and out), an org owner/admin gain and loss fanned out over every project of the org, a new project seeded with the org's owners and admins, a display-name change, and the project cascade, with a direct write to either register refused; an org owner/admin gaining an active `engineer` membership losing the membership-less `pmc` row and regaining it when that membership ends; a user provisioned after 4d-i holding an identity row from the insert and their later fact accepted; an org owner/admin holding an active `engineer` membership recording a `MembershipTransition` with `actorRole = 'engineer'` and committing (authority from the `OrgUserAuthority` row), the same fact with `actorRole = 'pmc'` refused, a plain engineer's refused for want of authority; the delivered `approve`'s notice-then-emit order committing under the deferred FK, a notice naming an event that never arrives refused at commit; a legitimate `decisions.effects` re-emission after crossing Q accepted with its own event excluded from the latest-demand lookup; `OrgUserAuthority` equal to the orgs truth after an owner/admin insert, promotion, demotion and removal, and after 4d-i's backfill; a forward to a `client` role designation with a live holder admitted and to one without refused | the stranded command; the standing register; `decisions.effects`; the membership seals |
| P30 | forward authority (holder/PMC/architect), ACTIVE target only, eligible states only — terminal AND `awaiting_countersign` refusals both probed through the guarded HTTP route with the shared `ROLE_POLICY` action | the forward command |
| P31 | the `awaiting_countersign` lifecycle: approval under a chain lands it with `finalized = false` — a revision BORN `finalized = true` under an active chain refused by the INSERT seal; the countersign is ONE atomic act sealed from BOTH sides (the boolean-only hostile flip refused; the orphan countersign row refused at commit; the split two-transaction replay refused; the REPLACED append-only seal — a DELETE and an UPDATE of any column other than the flip refused, the paired flip accepted, the delivered `_append_only` trigger absent by name after 4d-i) AND attributed to an ACTIVE architect AND carrying provenance (the 4c arms verbatim) AND carrying its EFFECTS — the finalizing event by the revision's recorded `approvedFrom` (the reopened → reapproved-into-awaiting → countersigned sequence end to end, with the `approved`/`reapproved` + `countersigned` audit rows), a countersign bundle WITHOUT its event, WITHOUT its audit row, WITHOUT its feed row, with TWO events, or with an event naming another actor, or whose event envelope carries a role or name other than the fact's frozen pair, each refused at commit (the no-chain approve's event with a NULL pair accepted before 4d-iii and refused after); the ENTRY sealed from the decision side (the bare transition with no revision, the re-entry onto a disposed head, the transition under an INACTIVE chain, each refused; the legal approve accepted with its provisional notice bound to its event); the awaiting ENTRY's bundle demanding exactly one `decision.awaiting_countersign` event — a receipt-backed hand-run entry WITHOUT it refused at commit, one carrying a `decision.approved`/`reapproved` instead refused, the legal entry's event carrying the architects frozen as `targetUserIds` and the payload's provisional act; a `DecisionEvent` UPDATE, DELETE and TRUNCATE each refused after a valid transition (the audit row as immutable as the fact); a countersign bundle whose feed row carries the wrong `kind`, or a `kind` with no `eventId`, refused at commit, and a feed row committed with a forged `text` RENDERED from its kind and event — the forged string served to no client, live, projected or rebuilt; a kinded row's `eventId`/`kind`/`decisionId` UPDATE (a NULLing included) and its DELETE refused, a forwarded pending decision withdrawn keeping its kinded notice hidden from every non-PMC viewer, and a kinded `decision.forwarded` notice ABSENT from a contractor's snapshot while the decision is hidden from them and PRESENT for the PMC and the holder; the awaiting entry's event with its push omitted, with a subset or superset of the active architects frozen, or with a body other than the catalog's constant, each refused at commit, and the exact set admitted; an audit row whose `actorName`, `actor` label or a named payload field disagrees with the fact refused; the seed's reset and the fixture's wipe succeeding on the 4d-i schema with `DecisionEvent_t4d_append_only` installed and enabled afterwards, every swept suite's cleanup succeeding through the helper, the bypass tripwire RED on a planted private `DISABLE TRIGGER` AND on a planted unguarded `decisionEvent.deleteMany`, the three rewritten precision arms asserting the append-only refusal by message with the approval guard's message still first on evidence rows, the two whole-table reset transactions passing; a feed row for project A bound to project B's event refused by the composite FK and the same-project binding accepted; the converse trigger: a standalone `decision.approved`, `decision.awaiting_countersign`, `decision.change_requested` and `decision.forwarded` each refused at commit without its fact, the consumer's `renotified` re-emit with its `countersign_renotified` row accepted; the frozen `approvedByName`/`approvedByRole` on every 4d-ii revision, a rename between the acts carrying the act-time name; the reader tripwire RED for the value the moment it exists; the Inbox item and badge; the architect's controls as a product path; the consultation carve-out and the response push for an architect requester; the web arm driving the client approval path under an active chain asserting the provisional copy; the converse admitting the countersign's and the `completed` resolution's finalization without a new revision row and refusing a standalone `decision.approved` with none of the three; the PMC's feed after a forwarded pending decision is withdrawn showing the withdrawal notice and neither the published nor the forwarding notice, both rows and events still present; every 4d-ii `decision.approved`/`reapproved` event carrying the exact `revisionId` (direct approve, countersign, `completed` resolution), the converse refusing an event naming a revision no same-transaction finalizer touched, a drain-shaped event without `revisionId` admitted through the same-transaction insert fallback and refused after 4d-iii, and an older kinded green notice of a twice-approved decision rendering ITS revision's approver, not the head's; the shell badge — `shellSummary.pendingDecisions` equal to `countPending` for the architect with one `awaiting_countersign` decision and no pending one, and for the PMC with a stranded one; **P31b/P42b** and **P31c/P34b** (§B) | `decisions.approve`; the register; the readers |
| P32 | self-countersign is TWO attributed acts under two idempotency keys — one combined act is refused; the two acts appear as two ledger receipts and two register facts | the countersign command |
| P33 | both disagreement outcomes: origin-stamped open `ChangeRequest`, `withdrawChange` refusal on `countersign_rejection`, the class-wide evidence freeze INCLUDING `decisionId`, `origin`, `revisionId`, `projectId`, `sourceCommandId` and the frozen role/name pair (the re-point, the re-label, the NULLing and the replacing UPDATEs each refused), impacts rendered, reject-back AND forward-on driven through re-approval to completion — forward-on through the ONE forward door with its `DecisionForward` fact (the request the bundle's provenance primary, the forward citing the same receipt); the `origin` serialized only when non-`standard` on live, projected and rebuilt DTOs and the Withdraw affordance SUPPRESSED for a rejection request while the direct call still 409s; the direct-SQL disagreement bundle by an ACTIVE architect with every pairing, standing and eligibility seal green but NO receipt refused at commit, and with NO event refused at commit; the standard request's receipt naming the request row (naming the decision refused at commit; the keyed replay appends nothing); **P33b** (§B.6) | the `ChangeRequest` machinery; the disagree command |
| P34 | the forward chain: attribution (actor vs displaced holder), the web Forward affordance following `rollout.phase6_4d`, the `decision.forwarded` emission + re-seal, the NON-HOLDER architect's product path (RED at base where the audience rule hides the row; absent for a removed architect and while the chain is inactive), the non-blank reason at both layers, the PAIRING sealed in BOTH directions (no row; a mismatched row; the orphan row; the same-target no-op at both doors), the DOOR status-gated (a matched forward on an `approved`/`recorded`/`withdrawn` decision refused; on an `awaiting_countersign` decision refused WITHOUT the same-tx rejection request), the TARGET's and the ACTOR's standing judged at the DB (a removed membership, an empty role, an inactive actor, an unauthorized actor, the role-holder arm's own case), the frozen `forwardedByRole`/`forwardedByName` judged (a hand-run forward by an active PMC freezing `architect` refused; a name that is not the account's refused), the forward bundle WITHOUT its event, audit row or notice refused at commit; the forward push's recipients FROZEN at emission (a role `toDesignation` resolved to its holders under the lock; the delivery payload carrying them) | the forward door; the attribution seal; the forward command |
| P35 | the forward-vs-approve barrier: both orderings deterministic, exactly one surviving outcome, a coherent holder; forward-vs-countersign likewise; every cancelling command vs a concurrent claim in both orderings under the ONE lock order, no deadlock | the row-lock serialization in the canonical order |
| P36 | the switch-writers barrier: architect role-change vs approve, activation AND deactivation, both orderings — the SERVICE activation and the HAND-RUN one (a direct INSERT under a hand-completed receipt with its fact and event) each vs `approve` and vs the stranded resolution, the hand-run writer refused as contended while the key is held and the terminal state asserted (approve-first → the activation lands after and the decision stays `approved`; activation-first → the approve lands `awaiting_countersign`); the orgs role mutations for `architect` in the §A enumeration; activation-vs-approve asserting the countersign deliveries per decision EXACTLY by ordering — approve-first under NO chain owes ZERO; activation-first → the approve's OWN emission is the ONE; a decision already awaiting when the activation crosses receives the ONE re-emit; never two for one decision; the ordered handlers' P-before-Q sequence with an approve landing between them; the NON-architect standing writers serialized — forward-to-`client`-role vs a direct insert of active client B in BOTH orderings (B-first → frozen set {A, B}; forward-first → B REFUSED as contended by `Membership_t4d_readiness`'s message, accepted after the commit, the frozen set equal to the audience at commit), the same for an `engineer` provisioning sign-in vs a forward to `engineer`, and for a forward to the `pmc` role vs an `OrgMembership` owner insert (B-first → {A, B}; forward-first → the org write REFUSED by `OrgMembership_t4d_readiness`, the frozen set equal to the audience at commit) — RED in the seal-stripped run where B commits mid-forward; the STALE ACTIVATION — B activated (Q) and removed (R) before the consumer reaches Q: Q recorded `noop` with `stale_activation`, no re-emit, no dead-letter, R handled next and cancelling the unsent pre-Q demands, the consumer's cursor past both; Q → R → S with C active at handling: exactly ONE fresh demand, frozen to C, S skipped — RED where the Q handler re-emits unconditionally and the empty-audience seal dead-letters it; PROJECT CREATION vs an owner insert for the same org in BOTH orderings, then a forward to the `pmc` role on the new project asserting no committed effective holder absent from the frozen set — RED in the seal-stripped run where the phantom lands; the same with a DIRECT `Project` insert (refused as contended by `Project_t4d_org_readiness` while the owner write holds the key, accepted after) — RED where the table door is omitted; demotion-vs-creation in both orderings (demotion-first → 403 at the in-key re-judge; creation-first → the project stands) — RED at base where the authority read precedes the transaction; a hand-run `renotified` bundle citing an activation crossing that PRECEDES the decision's latest demand refused by the converse, one citing a crossing at or after it admitted | `lockProjectReadiness` on the orgs role mutations, the four other `Membership` writers and the org owner/admin writers; `lockOrgStanding` on project creation and the org writers; `Membership_t4d_readiness`/`OrgMembership_t4d_readiness` (4d-iii); `decisions.effects` |
| P37 | EVERY entry into `approved` sealed behind the chain, SERIALIZED by `phase6_try_readiness`: under an ACTIVE chain the direct `pending → approved` hostile flip refused, the finalized-boolean-only flip refused, the awaiting-flip without the SAME-TX countersign ROW refused, the standard `withdrawChange` restoration PASSES, the `countersign_rejection` restoration refused; under an INACTIVE chain direct approval legal ONLY from `pending`/`change` AND ONLY WITH ITS BUNDLE — the receipt-backed direct bundle with revision, transition, event and audit row ACCEPTED, the stream advanced and the `decisions.inbox` fold applied; the same bundle without its event refused at commit; with two events refused; with an event whose `actorId` is not the revision's approver refused; with the audit row missing refused; an event inserted at the stream's `nextPosition` without the increment refused by the envelope seal, one at an already-taken position refused by the uniqueness, a second event after one increment refused, an increment by two refused by the allocation seal, an increment with no event at the allocated position refused at commit (no gap, no double allocation representable); the `insertRawEvent` fixture's insert admitted and the delivered envelope arms passing unchanged, a legacy plant admitted only inside its named bypass and refused outside it, the raw-insert tripwire RED on an unlisted site; an intent naming an unknown `(coverageVersion, effectKey)`, a key whose catalog `eventType` is not the event's, a mismatched `invalidate`, a push outside the ceiling, or `targetUserIds` on a family without a frozen audience, each refused, and an intent copied from the catalog row admitted; after 4d-iii, an event of either kind without the envelope pair refused and every write-through emitter — a PO issue and amendment, a labour PO, an inventory receipt, a measurement, the activation CLI, the re-evaluate CLI — committing `commercial.money_moved` WITH the pair (RED at base where `AttributionActor` drops the name) AND with its delivery rows derived from the persisted catalog by a process that booted no registry (RED at base, where `materializeDeliveries` writes nothing without one); a `dispatch` row whose `payload.body`, `roles`, `targetUserId` or `targetUserIds` differs from its event's intent, or whose `subject` is not the event's `entityId`, refused at insert, the previous release's `{body, roles, targetUserId}` shape admitted for an intent without `targetUserIds`, an UPDATE of a delivery's `payload`, `subject` or identity refused, the 4a cancellation mark (`dispatch → noop` with `cancelledAt`, payload preserved) admitted and a bare `deliveryAction` flip refused; without a feed row bound to the event refused, and BEFORE 4d-iii the previous release's write shape (feed row with NULL `eventId` and NULL `kind`) accepted — the bare awaiting-flip refused without the stranded-resolution fact; the first-architect-activation-vs-approval barrier deterministic in both orderings; a `DecisionConsultation` or response inserted without its same-transaction `decision.consultation_requested`/`responded` event refused at commit, the event without its fact refused, the delivered service path unchanged and accepted; a `ProjectEventStream` row DELETE refused, an INSERT at `nextPosition ≠ 0` or for a project holding events refused, the project-deletion cascade admitted; a delivery's `cancelledAt` cleared, rewritten, or set outside the mark's statement or the leased/dead mark-only arm refused, the mark itself admitted; a `decision.approved` bundle without its push, or with `roles` narrower than the broadcast ceiling, refused and the delivered shape admitted; the envelope insert and the gated retirement stamp under the barrier in both orderings — an intent retired before the insert's lock refused, one retired after the insert's commit admitted, never an event on a retired intent; a consultation request or response whose envelope pair differs from the fact's frozen pair refused, a request event targeting a user other than the frozen consultee or a response event targeting a user other than the requester refused; a chain check reading `platform_role_standing` equal to the orgs truth after every architect transition shape; the relay's leased-cancel completion and its pre-intent neutralization admitted by the frozen-delivery seal, a bare `dispatch → noop` on an unmarked row with an intent refused; a delivery row planted for an INACTIVE consumer whose action contradicts its persisted rule refused at insert, one that matches admitted and left in place by the next expansion pass; a writer minting its event id, stamping the notice first and emitting second committing with the deferred FK satisfied; the architect arm of both 4b seals judged from `ProjectRoleStanding` — an architect-designated open decision refused with the register at zero and admitted once the orgs trigger writes the row — and the boundary tripwire asserting the seal functions' architect branches name no orgs table; a hand-run demand whose `targetUserIds` is `[A, A]` for one active architect refused, `[A]` admitted, and a delivery row carrying a non-canonical copy of a canonical intent refused; with a published `pending` decision designated to the architect role and ONE active architect, that membership's removal, deactivation and re-role each REFUSED by `Membership_t4b2_holder_guard`'s architect arm reading the post-write register, TWO architects removed in one statement refused likewise, and the same removal admitted once the decision is resolved (RED against the AFTER-ordered register trigger, where the guard read `1` and the count landed at zero) | the status-transition seal + obligation 7 |
| P38 | the pre-send eligibility guard generalized to EVERY targeted decision push through PER-EVENT-FAMILY predicates — the two NEW families (`countersign`: awaiting + active architect; `forward`: installed holder AND `pending`/`change`) beside the three delivered: one positive AND one negative per new family; a valid consultee push NOT dropped by the countersign predicate; the responded predicate widened to the architect requester WITH the withdrawn-audience arm; a REQUEST push enqueued before a withdrawal cancelled for every consultee; the two new predicates bound under the BUMPED `webpush.notify` contract (`catalogVersion` 2 → 3), a process compiled at the old version refused by `syncConsumerCatalog` at startup, the catalog-data migration in `ALWAYS_EXECUTE` (a P3005 baseline over a pre-4d-ii database runs it and the upgraded process starts), a SECOND execution of 4d-ii's catalog file over an already-registered database a no-op; the `decisions.effects` REGISTRATION over a database holding historical events — every historical delivery `succeeded`/`noop`, zero notifications, zero `countersign_renotified` rows; the external-effect RESEAL sequence — the 4d-ii build refused in outbox mode under the 4d-i seal, served in shadow, resealed, then booting in outbox mode; the PERSISTED catalog — 4d-i's seeded rows equal to `canonicalCatalog()` at its coverage version (the tripwire), an intent at the pre-4d-ii version admitted through the drain while 4d-ii's rows stand beside it, refused after 4d-iii retires them, the singleton seal version equal to the newest UNRETIRED persisted version at boot, a direct UPDATE, DELETE or TRUNCATE of the catalog refused; `targetUserIds` admitted by `buildDispatchIntent` only for the two frozen-audience families and refused elsewhere; the response push of a requester re-roled between request and response carrying the FROZEN request-time role, a `consultation.request` whose `requestedByRole` the requester does not hold refused by the INSERT seal, a legacy NULL-role consultation's response pushed as `pmc`; the ACTIVATION boundary — a direct `UPDATE` of `OutboxConsumerCatalog.active` or `registeredAt` refused, an appended `OutboxConsumerActivation` row flipping the mirror, an UPDATE or DELETE of the register refused; a consumer deactivated for event N (no row demanded, the seal passing) and reactivated at N + 1 receiving N's row from the next expansion pass and its ordered cursor advancing through N; `decisions.effects` registered inactive with no row demanded of a pre-4d-ii-shaped emit, activated by 4d-iii's appended row with every historical delivery `succeeded`/`noop`; a direct `UPDATE`, `DELETE` or `TRUNCATE` of the activation register refused, a blank or all-whitespace `reason` refused; a `ReleaseLease` row's `instanceId`/`release`/`catalogVersion`/`startedAt` UPDATE refused, a `leaseUntil` decrease refused, DELETE and TRUNCATE refused, the renewal admitted; two operator activation appends under the deterministic barrier in both orderings — the second refused with a stale sequence, the mirror equal to the highest committed fact, never reordered; an event and an activation append under the barrier in both orderings — the activation before the event's read owed a row, the activation after the event's commit owing none, never an event without a row for a consumer active at its commit | the per-family registration + the two new `decisions.*PushTarget` queries + the consumer catalog bump |
| P39 | the delivered orphan guard EXTENDED: removing or re-roling the NAMED holder, or the last active member of a ROLE designation, of an `awaiting_countersign` decision refused at BOTH layers (409 through `holdsOpenDecisions`; the DB guard on the hostile direct write); removing the LAST ARCHITECT NOT refused — it deactivates the chain (P29b) — INCLUDING when that architect is the named holder or the last member of the architect ROLE designation an awaiting decision names (the one named exemption), while a named holder who is an architect but not the last is refused naming the pending countersign, and a `pending`/`change` decision designated to the role still refuses removing its last architect | `holdsOpenDecisions` + `phase6_t4b2_membership_guard`, open set widened |
| P40 | the send boundary per family (§A.2): the claim-time re-target (the `deciderPushTarget` read taking the decision row lock); the invalidation-vs-claim barrier in both orderings for the decider, forward, countersign (the frozen-set arms), user-targeted and consultation families; the direct-transition arm and the fan-out arm; the archive arm — the delivery dropped with the mark at the pre-send barrier and NOTHING re-notified on restoration, the awaiting decision served to the architect's next read; the responded family's target-aware re-judge; the withdraw-vs-respond barrier in both orderings; the delivery row after a partial fan-out `succeeded`/`dispatch` with NO mark, marked only when every resolved recipient is stale; the consultee push surviving each; the residual stated per family | the consumer's per-recipient hook; the cancellation inventory |
| P41 | the delivered 4c lock-order + terminal-state probe EXTENDED to the transitions 4d adds that CLOSE the consultation-open set: `consultation.request` and `consultation.respond` vs the COUNTERSIGN, vs the `completed` stranded resolution, and vs the standard `withdrawChange`, each in BOTH orderings under the canonical lock order, asserting the TERMINAL invariant directly — consultation-first leaves the historical consultation/response standing and the finalizer commits `approved` beside it; finalize-first returns 409 with NO consultation row, NO response row and NO `consultation_*` effect; the `returned` resolution and the countersign REJECTION land `change`, which stays in the open set, so the same probe asserts the consultation ACCEPTED after them; no deadlock abort in either ordering | `decisions.service.ts` `requestConsultation` / `respondToConsultation` (the delivered 4c commands — there is no `consultations.service.ts`); `decisions.countersign`, `resolveStrandedCountersign`, `withdrawChange` |
| P42 | the finality candidate key over the ACTUAL provenance columns: provenance onto an unfinalized revision unrepresentable (both spec tables); `finalized → false` under reference refused by the FK; the additive backfill leaves every legacy revision `finalized = true` and every legacy spec row `revisionFinalized = true`, proven over the legacy fixture in `upgrade-proof.sh`; the DEFAULTS hold through the drain — a revision, a material spec and a labour spec inserted WITHOUT the new columns all succeed on the 4d-i schema and land `true`, a `ChangeRequest` inserted WITHOUT `projectId` is filled from its decision and one naming another project's id is refused by the composite FK, a `Notification` inserted WITHOUT `eventId` succeeds; 4d-iii's drop of the defaults probed by the same inserts then failing AND by a current-version provenance write through the SHIPPED writers — create, revise AND cancel, material and labour — succeeding with `revisionFinalized = true` from the widened `approvedRef` (RED at base); 4d-iii's trailing seals — a NULL-`sourceCommandId` standard request refused while the legacy NULL rows survive; a decision notification without `eventId` or without `kind` refused while legacy rows survive; a new `DecisionApprovalRevision` without `approvedByName` or `approvedByRole` refused while the legacy NULL rows survive (a receipt-backed no-chain approval after the drain cannot lose its attribution); the retired catalog version's intent refused; **P42b** with P31b (§B.4); the drain-window interleaving — a `Project` INSERT and an owner/admin `OrgMembership` INSERT under the barrier in both orderings during the 4d-i → 4d-iii window leaving no `pmc` row, 4d-iii's re-projection restoring it behind the table fence before any door installs, and a direct-SQL `Project` + owner/admin `OrgMembership` pair started AFTER the fence observed BLOCKED in `pg_stat_activity`, the migration committing its repair and its doors, the pair then meeting the doors — exactly ONE commits, the other is REFUSED by its door's message, the refused statement RETRIED after the winner commits succeeds, the terminal state holds the `pmc` row, both resume orders (the pair started BEFORE the fence delays the fence until it ends and IS repaired); 4d-iii over a `decisions.effects` an operator activated then deactivated — the retirement re-activating at the next sequence and verifying the head, a retirement whose verification fails leaving every door installed, a replay over an active head appending nothing | `DecisionApprovalRevision_provenance_target_key` widened + the two spec FKs re-targeted; the trailing seals |

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
  `phase_plan` stays the 4c plan until this plan CLEARS, when the
  implementation's first fold moves it. Runner invariants over the parsed
  Now block: `assessRunnerState` → `pr:<this>` while open;
  `assessPostMergeRunnerState` → simulated, allowed, `task:4`;
  `detectStatusDrift` with the self-named `open_pr` live → no drift. It
  clears by a fresh clean +1 through the `codex-current-head` gate — the
  independent clearance the 4c plan's #486/#490 detour restored as a
  precondition — and 4d implementation begins only after that merge, from
  the `main` that carries it. Should this PR reach a second finding-bearing
  head, the protocol's close-and-replace applies exactly as it did sixteen
  times before, under the standing continuation authorization (#482,
  2026-09-07): a freshly scoped replacement from current `main` carrying
  `Replaces: #<this>` and every unresolved finding — no PR-number cap.

- **4d implementation follows as FOUR PRs — the dark migration 4d-i, the
  service/role/UI unit 4d-ii, a drain attestation, and the trailing
  reservation retirement 4d-iii — each honouring the mandatory migration
  seam** (the additive schema is deployable before any caller uses it — that
  viable seam makes a single migration+service+UI PR a violation of the
  repository's migration review-unit rule, and this plan takes the seam):

  - **4d-i, the migration unit — MIGRATION-ONLY in the template's sense**:
    its diff touches `prisma/` (the migration file, the schema mirror, the
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
    path in its diff is a scope finding. ONE additive
    migration file in THREE parts, ordered so no window opens. **Part 1, the doors transaction**:
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
    decisions-owned `DecisionEvent_t4d_append_only` seal; `Notification.kind`
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
    `Notification_t4d_binding` same-decision INSERT arm, the decisions-owned
    `ChangeRequest` closure↔restoration trigger and the
    `countersign_renotified` partial unique; the platform-owned `ProjectRoleStanding` register
    with its writer-depth seal, its project-cascade arm, the orgs-owned
    `Project_t4d_deleting` flag trigger and `ProjectRoleStanding_t4d_no_truncate`,
    backfilled to one `architect` row per project at zero;
    `Membership_t4d_no_truncate`; the orgs-owned `MembershipTransition` fact
    (registered in `orgsManifest.ownsModels`/`readEncapsulated`) with its
    frozen `actorRole`/`actorName` pair, its
    deferred membership FK, its receipt FK, its one-use UNIQUE, its
    append-only and `MembershipTransition_t4d_no_truncate` seals, the
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
    with its gated one-way stamp and the seed's `ON CONFLICT DO NOTHING`; the two CONVERSE pairing
    triggers on the kernel table — the orgs-owned
    `DomainEvent_t4d_standing_event_paired` and the decisions-owned
    `DomainEvent_t4d_decision_event_paired`; the reset protocol in
    `prisma/seed.ts` and `test/integration/fixtures.ts` gaining
    `DecisionEvent_t4d_append_only`, the membership path (transition facts,
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
    reset truncating `DomainEvent` TOGETHER WITH `Notification` under the
    named disables, and every `notification.deleteMany` /
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
    CASCADE` reaches `ChangeRequest`), and the two-producer P33b pairing; the
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
    target- and actor-judged) and the approved-entry seal with its
    decision-side `awaiting_countersign` entry arm; the
    `phase6_t4b2_membership_guard` open set widened with its one named
    exemption; the two 4c consultation seals `CREATE OR REPLACE`d with the
    `awaiting_countersign` arm and the requester arm moved onto
    `platform_user_orchestration_authority` (`phase6_user_decision_authority`
    byte-identical); and the remaining reservation door
    `DecisionForward_t4d_reserved`. **The TRANSIENT portion is a NO-OP once 4d
    has retired**: in `ALWAYS_EXECUTE` a later P3005 baseline of a MATURE
    database — one holding a legitimate active architect after 4d-iii —
    replays 4d-i before 4d-iii, and an unconditional file would re-create
    the reservation and ABORT on that valid row. 4d-i therefore SPLITS its
    body: the PERMANENT guards (tables, columns, seals, backfills,
    primitives, the register) run unconditionally and re-runnably, while the
    TRANSIENT block — all FIVE reservation triggers, their SHARED refusal
    function and the audit — runs only when the durable RETIREMENT MARKER is
    absent. That marker is one row in a NEW, sealed platform table
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
    partial apply retries. `TRUNCATE_SEALS` gains FIFTEEN entries across
    4d-i and 4d-ii — the three fact tables,
    `ProjectRoleStanding_t4d_no_truncate`, `Membership_t4d_no_truncate`,
    `MembershipTransition_t4d_no_truncate`, `ChangeRequest_t4d_no_truncate`,
    `ExternalEffectCatalog_t4d_no_truncate`, `Notification_t4d_no_truncate`
    (#560's review round 1, finding 10: the count said nine and the list
    named eight), `OutboxConsumerActivation_t4d_no_truncate` and
    `ReleaseLease_t4d_no_truncate` (#560's review round 2, findings 2 and 6:
    evidence registers that refused UPDATE and DELETE but not TRUNCATE),
    `ProjectUserStanding_t4d_no_truncate`, `UserIdentity_t4d_no_truncate` and
    `ProjectEventStream_t4d_no_truncate` (#561's review round 1, findings 1
    and 7) and `OrgUserAuthority_t4d_no_truncate` (#562's review round 1,
    finding 2) —
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
    produce any new value, and the ONE 4d-sealed transition it can perform —
    the no-chain approve — already writes the event and audit row the
    correspondence requires and keeps writing its feed row without
    `eventId`, which the seal admits until 4d-iii. **4d-i is expected to
    EXCEED the standard budget on probes alone and its packet MUST carry
    the large-unit evidence** (#564's review round 2, finding 3: "argues
    `justified-large`" required neither the marker nor the matrix the
    repository's scope gate blocks on): it declares the exact
    `<!-- review-size: justified-large -->` marker with the visible
    restatement, completes all six invariant-matrix rows and the five
    pre-review checks, lists its file inventory, and carries its
    `<!-- migration-scope: inseparable -->` marker with the stated
    boundary above — exactly what 4d-ii's paragraph requires of 4d-ii.

  - **4d-ii, the service/role/UI unit**: the role fan-out (§A.1 — every
    mirror, the policy rows, the web lists, the DESIGNATION fan-out, the
    `deciderPush` architect arm, the `deciderPushTarget` arm, `countPending`);
    the four commands (`decisions.forward`, `decisions.countersign`,
    `decisions.disagree` with its two paths,
    `decisions.resolveStrandedCountersign`) on the command ledger with
    idempotency keys and `lockProjectReadiness` in the canonical order, each
    writing its fact with the frozen role and name from the actor's token,
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
    `eventId` and `kind`, every feed reader (the
    snapshot builder, the `decisions.inbox` fold and rebuild) rendering a
    kinded row from its kind, event and frozen fact under the renderer
    tripwire and filtering it through `decisionVisibleToViewer` for its bound
    decision, the withdraw's notice retirement narrowed to kind-less rows,
    and the orgs participant's `effectiveRoleHolderUserIds` wrapping
    `platform_role_holder_user_ids`; the `withdrawChange` refusal;
    `decisions.approvedRef` returning `revisionFinalized` and refusing an
    unfinalized head, with the material and labour create/revise writers
    spreading it explicitly, the two cancellation copies carrying it forward,
    and the writer sweep; `requestChange` recording `sourceCommandId` with
    its receipt naming the created request row; `emitEvent` writing the
    envelope's `actorRole`/`actorName` from a kernel `EventActor` widened to
    the FULL `Actor`, `AttributionActor` carrying the pair through the
    commercial, procurement, labour and inventory seams, and
    `OrgsParticipant.resolveUserIdentity` returning the display name
    (#555's review round 2, finding 1, staged here — #556's review round 1,
    finding 3); the three orgs membership
    mutations becoming commands writing their `MembershipTransition` row and
    emitting `membership.standing_changed` on a standing flip;
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
    `rollout:drain-evidence` CLI; `syncConsumerCatalog` VERIFYING each
    consumer's persisted `dispatchRule`/`subscribedEventTypes` against the
    compiled contract and refusing on drift, never writing them (#560's
    review round 1, finding 7: this checklist said "writing", contradicting
    the sealed-evidence rule); the delivery-row rewrite — the platform's
    `deliveryRowsFor` projection called by `materializeDeliveries` and
    `expandMissingDeliveries`, `deliveryFor` retired, the
    `OutboxConsumerActivation` register with the frozen `active` mirror,
    the operator `outbox:consumer` activation command, and the
    `DomainEvent_t4d_deliveries`, `OutboxDelivery_t4d_bound` and
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
    appended register row after the drain — with
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
    one-time observation; 4d-ii therefore carries this ONE catalog-data
    migration beside its service change and declares the seam inseparable in
    its packet for the reason 4c-ii did (the version and the code that
    declares it must move together); the socket consumer is not bumped.
    **4d-ii is a CATALOG CHANGE, staged as one**: its new push families and
    widened targeted entries change the sealed external-effect coverage
    hash, and the delivered `OutboxBootstrap` REFUSES to start in
    `OUTBOX_SENDER_MODE=outbox` while the persisted seal differs from the
    compiled catalog, so its staging follows `docs/RUNBOOK.md`'s
    catalog-change sequence, written into the packet as steps: drain the old
    fleet to zero instances → deploy 4d-ii in legacy/shadow sender mode →
    rebuild projections → `outbox:status` clean → `outbox:seal-external`
    recording the NEW coverage → restart in outbox mode, the startup
    validating the seal — BEFORE 4d-iii. **Still chain-off AND forward-off
    everywhere**, because the reservation stands on all five doors: the unit
    ships every reader and writer while no project can exercise them, which
    is what makes the previous-release drain a pure operational step. Its
    STATUS fold SETS `blocking_directive: phase-6-4d-previous-release-drained`.
    **4d-ii is expected to EXCEED the standard budget and its packet MUST
    carry the large-unit evidence** (#560's review round 1, finding 9): it
    declares `<!-- review-size: justified-large -->` with the visible
    restatement, completes all six invariant-matrix rows and the five
    pre-review checks, and lists its file inventory. The seams were
    considered and are stated in that packet, not assumed: the migration
    seam is INSEPARABLE for the reason above (the catalog version and the
    code that declares it move together, as 4c-ii's did); the service/UI
    seam is inseparable because the `countersign-v1` client boundary (§A.2)
    makes a server without its client refuse every deployed browser
    session, and a client without its server ships surfaces no response
    can populate and no browser proof can drive. What CAN be cut is
    already outside it: the dark seals (4d-i), the reservation retirement
    and the standing-writer seals (4d-iii), and the drain.

  - **The drain attestation** — the operator states that every process older
    than the 4d-ii release is stopped or drained, as an `OPERATOR-ATTESTATION`
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
    attestation** (#558's review round 1, finding 4: a gate only a human can
    clear leaves an autonomous loop `in_progress` with no human standing by;
    a review finding cannot lift a recorded Board decision, and this plan
    does not pretend to — it adds the evidence and raised the question on
    #482, where the controlling answer is recorded: comment 5569586836,
    2026-09-07 — the user's standing instructions RETAIN human production
    attestation; evidence does NOT replace the direct explicit operator
    attestation; a review request for greater autonomy cannot authorize its
    removal, and no agent-authored statement can supply a policy change or a
    runtime fact). Two pieces of trusted autonomous evidence, both shipped in 4d-ii:
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
    of the human requirement is the user's separate decision, never
    inferred from a review finding, a coordinator note or this plan.

  - **4d-iii, the reservation retirement**: a migration-only unit whose
    transaction, after its `SET LOCAL` gate, FIRST takes `LOCK TABLE
    "Project", "OrgMembership", "Membership" IN SHARE ROW EXCLUSIVE MODE`
    in that one order and holds it to commit — the fence behind which
    every write of those tables from any writer, service or direct, ends
    before the snapshot and none commits before the doors (#563's review
    round 2, finding 1) — and takes NO org key; THEN re-projects
    `ProjectUserStanding` and `OrgUserAuthority` from the orgs truth, org
    by org in ascending id, recording the diff in its closing report
    (#562's review round 2, finding 3); and only then drops
    ALL FIVE reservation doors with their shared function, drops the two
    kept finality defaults (`finalized`, `revisionFinalized` — after the
    drain only writers that state the pin remain), installs the TRAILING
    INSERT-time seals — `ChangeRequest_t4d_provenance_required`:
    `sourceCommandId` AND the frozen
    `requestedByRole`/`requestedByName` pair required on every new
    `ChangeRequest` row whatever its origin (#560's review round 2, finding
    1: the inventory named the receipt and not the pair, so the actor-id-only
    correspondence branch this unit is stated to close would have stayed
    open for a standard request), **with the seed's DL-003 plant rewritten
    in the SAME unit as its one NAMED bypass** (#564's review round 2,
    finding 1: `prisma/seed.ts` recreates the reopened decision's open
    request with `requestedById` alone — a pre-4d-shaped row in a seeded
    world that carries no events — and a normal post-migration seed would
    abort on this seal): the plant runs inside one `$transaction` that
    disables `ChangeRequest_t4d_provenance_required` by name in the seed's
    existing `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …) … DISABLE
    TRIGGER` shape and re-enables it after, so a pre-4d-iii database seeds
    unchanged; it is the ONLY admitted site under the statement tripwire
    (every other `changeRequest.create` in the repository is the service
    writer or an asserted hostile refusal), and P28b's reset arm runs the
    FULL seed on the post-4d-iii schema — a fresh database migrated through
    4d-iii, then a mature reseed — asserting it succeeds with every seal
    enabled afterwards and the planted request a legacy-shaped row, `Notification.eventId` AND
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
    `decisions.effects` catalog row `FOR UPDATE`, reads the activation head
    and — only if the consumer is NOT active — APPENDS its activation at
    `activationSeq + 1` under the gate, then VERIFIES in the same
    transaction that the head is active, aborting the whole retirement with
    every door intact otherwise (#561's review round 2, finding 3: a
    fixed-sequence `ON CONFLICT DO NOTHING` insert could be skipped by an
    operator activation-then-deactivation that consumed the sequence,
    retiring the doors with the consumer inactive; a replay over an active
    head appends nothing; the next relay pass expands its whole history per
    the persisted rule — the P38 activation arm), and writes the sealed `RolloutRetirement` marker (`INSERT … ON
    CONFLICT (unit) DO NOTHING` under the `SET LOCAL` gate, so a later
    `ALWAYS_EXECUTE` replay over the immutable row neither aborts nor
    rewrites it, the closing verification requiring the row to EXIST);
    re-runnable — every replay re-drops ALL FIVE reservation triggers
    (`Decision_t4d_architect_reserved`, `Decision_t4d_awaiting_reserved`,
    `Membership_t4d_architect_reserved`, `User_t4d_architect_reserved`,
    `DecisionForward_t4d_reserved`) AND their shared
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
