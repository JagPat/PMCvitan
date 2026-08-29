# Decision workflow, unit 4c — consultation: the plan

**Status: PLANNING — this is the docs-only 4c plan unit the merged 4b plan's
§E order requires** (`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`
§E: "the 4c plan unit — its own docs-only review; STARTING MATERIAL: the §B
consultation design at PR #340 head `6a53aae` + §D obligations 1–3 — → 4c
implementation"). It must clear its own exact-head review to a fresh clean +1
before 4c implementation begins — the same plan-first contract that preceded
4a and 4b, both now DELIVERED AND CLEARED (4a: PR #337; 4b: PR #468 merged at
`main` `fe9df58d` after the eleven-round lineage #463→#468, packet
`docs/reviews/phase-6-t4b-decider-packet.md`).

## Provenance, and what is NOT re-litigated

The STARTING MATERIAL is the §B consultation design at PR #340 head `6a53aae`
(`docs/superpowers/plans/2026-08-14-decision-workflow-4b-4d.md` there, §B +
the unit-4c probe table in its §D), carried here in substance with each
decision's forcing round annotated — none reopened. The binding ledgers
(`docs/reviews/pr-335-convergence.md`, `docs/reviews/pr-340-convergence.md`)
stand; the merged 4b plan's §D carries obligations 1–3 to THIS unit as named
probes (P25c, P25d, P38c/P40c), elaborated to full rows in §C below. Nothing
is dismissed and nothing settled is redesigned.

4b's DELIVERED surface is settled input, and this plan is written against what
actually merged (not the pre-delivery sketch):

- the decider model (`deciderKind` client/pmc/member/none, the holder freeze
  from publication, `decisions.updateDraft` as the drafting door) and the
  `Membership @@unique([projectId, id])` candidate key 4c's composite FKs bind;
- the user-TARGETED push spine: subscription↔user linkage with credential
  version + token expiry, the project-scoped sign-out AND persona-switch
  unlink, `notifyTargetedUser` through the orgs-owned `sessionStillValid`,
  and the catalog-declared claim-time predicate (`deciderPushTarget` shape);
- the §B.1 try-acquire-or-refuse protocol (`phase6_try_readiness`) with the
  round-8 KEY-BEFORE-JUDGEMENT rule: a seal takes its serialization key BEFORE
  consulting row existence, never after a prefilter that concurrent
  uncommitted writes can empty;
- the §B.2 owned SQL primitives (`phase6_membership_is_active`,
  `phase6_effective_role_standing`, `phase6_user_decision_authority`) — DB
  seals ask cross-module questions through these, never raw joins invented
  per-seal;
- the round-11 LIVE-STANDING rule: an act's authorizing role is re-validated
  inside the transaction via `OrgsParticipant.hasProjectRoleStanding` with
  `forUpdate` — a guard-passed JWT role is never trusted at write time;
- `decisionVisibleToViewer` + the `decisions.inbox` projection thread
  (row/fold/rebuild/filter) that P22 delivered, which P25c extends.

## §A — The design (the §B starting material, carried)

Two labour-adjacent append-only facts, owned by decisions:
`DecisionConsultation` (**`projectId`**, decisionId, requestedById,
consulteeMembershipId, question, requestedAt) — the child carries its OWN
`projectId` (round 2: a composite FK cannot bind columns the child does not
have), and BOTH references are project-scoped through it: the composite FK
onto the `(projectId, id)` candidate key 4b added to `Membership`, and a
composite FK onto `Decision(projectId, id)`, so a project-A consultation can
never name a project-B consultee or decision — and
`DecisionConsultationResponse` (consultationId, response text, an OPTIONAL
recommended option, respondedAt; append-only, sealed — and ONE per
consultation, PR #340 round 5: a UNIQUE constraint on `consultationId` makes
a second response unrepresentable — readers model a singular response, and
two contradictory immutable recommendations with a doubled
`consultation_responded` push must not exist — with the command returning a
deterministic 409 on a repeat under a different idempotency key; the
duplicate service path AND the direct duplicate insert are probed, P23).

**The recommendation is a same-decision option REFERENCE, never a raw index**
(round 2): an index is append-only evidence bound to nothing — `3` on a
two-option decision is immutable nonsense, and an index survives option
reordering pointing somewhere else. The response stores the server-resolved
`DecisionOption` id under composite FKs constrained to the SAME decision —
and the response row carries the CHILD KEYS those FKs need (round 3): its own
`decisionId`, bound TWICE — `(consultationId, decisionId)` referencing a
`(id, decisionId)` candidate key on `DecisionConsultation`, and
`(decisionId, recommendedOptionId)` referencing a `(decisionId, id)`
candidate key on `DecisionOption` — so a response naming a foreign decision's
option is unrepresentable, hostile-probed with an out-of-range index AND a
foreign option id (P27). A consultation on a RECORD cannot arise (records are
ineligible below), so the option reference is always against a choice's 2–4
frozen-after-publication options.

**`question` and `response` are user-supplied EVIDENCE** (round 1): zod
`trim().min(1)` at the contract AND the exact repository CHECK
`btrim(x, E' \t\n\x0B\f\r') <> ''` on both columns, with P23 asserting the
whitespace-only refusal at both layers.

The PMC requests (the `architect` joins the requester set IN 4d with the role
— the same staging rule as the decider value); the named member responds; the
thread renders under the decision in the register and the decider's view.
Three invariants: consultation NEVER moves `status`, NEVER changes a gate
verdict (P24), and WIDENS visibility exactly one way — a consultee sees THAT
decision (and its thread) while their consultation stands, an exception added
beside AUTH-02 in `decisionVisibleToViewer`, not a rewrite of it.

**The widening has an ELIGIBILITY carve-out** (rounds 2–4): a consultation may
be requested only on a decision whose question is still OPEN — in 4c that set
is `pending` or `change` (the `awaiting_countersign` arm is ADDED BY 4d with
the status itself) **AND PUBLISHED** (round 4: status alone admits an
author-private DRAFT whose `status` is `pending`; `publishedAt IS NOT NULL`
joins the request AND response guards) — never on `withdrawn` (whose title
and reason are pmc-only; a consultation there would leak exactly what 4a
hides), `approved`, or `recorded` (nothing left to inform). Refused 409 at
the service, with the withdrawn-leak probe asserting a consultee gains NO
visibility of a withdrawn row (P25). **The RESPONSE re-checks the same
eligibility at ITS moment** (round 3): a request made while `pending`
outlives the decision, and a stale response after a withdrawal would append
evidence — and push — against a row the consultee must no longer see; refused
409, probed by request → withdraw → late-response (P25). **And BOTH checks
run UNDER the decision row lock** (round-5 obligation 5): the eligibility
read takes the decision row's share lock inside the command transaction — the
lock-before-read rule 4a's own linkability authority follows — so a
withdrawal committing concurrently either waits or is seen; the
request-vs-withdraw barrier probe proves both orderings deterministic (P41).

**And the eligibility is sealed at the ROW, not only the command** (round 4):
the append-only `DecisionConsultation` row is the durable fact that widens
`decisionVisibleToViewer`, so a direct INSERT bypassing the locked command
path would grant standing visibility onto an ineligible decision — a
withdrawn row's pmc-only title leaking to a fabricated consultee. A DB INSERT
seal re-judges the command's own predicate (status `pending`/`change` —
`awaiting_countersign` joins in 4d — AND `publishedAt IS NOT NULL`, AND the
consultee membership ACTIVE via `phase6_membership_is_active`, AND
`requestedById` holding ACTIVE requesting authority — pmc via
`phase6_user_decision_authority`, joined by architect in 4d: the contract's
actor-standing obligation applied to this fact's RECORDED actor, round 5)
under the decision row's share lock. Delivered-4b disciplines apply to this
seal verbatim: it serializes through the §B.1 try-acquire-or-refuse readiness
protocol (reentrant on the service path, hold-to-commit when free, REFUSE
when contended — never blocking inside a trigger), and it takes its locks
BEFORE consulting decision or standing state (the round-8 key-before-
judgement rule). The hostile row against a withdrawn AND a draft decision,
and the unauthorized-requester row, are probed (P25); the RESPONSE side's own
hostile inserts are P25d (§B below).

**The RESPONSE command's live standing** (the 4b round-11 rule instantiated):
`consultations.respond` re-validates INSIDE its transaction that the caller
IS the named consultee's user and that the consultee membership is STILL
ACTIVE — through `OrgsParticipant.lockActiveMembershipById` (the same in-tx
re-lock the 4b approve path uses for a named decider) — so a consultee
removed after their JWT was minted cannot append immutable advice. The
REQUEST command re-validates the requester's pmc standing the same way
(`hasProjectRoleStanding` with `forUpdate`).

Events `decision.consultation_requested` (push to the consultee) and
`decision.consultation_responded` (push to the requester) join the catalog
with the 4a re-seal discipline, riding 4b's user-targeted dispatch — the
consultee is resolved from their membership; the requester may be an
org-admin USER with no membership row, which is exactly why the target is
user-keyed (P26). Both events inherit the generalized pre-send/claim-time
eligibility class of the merged 4b plan's §A.3 — the 4c instantiation is
P38c/P40c (§B below). The consultee is a MEMBERSHIP — when external
collaborators arrive (6.2+), they arrive as members and this table already
names them.

## §B — The carried §D obligations, elaborated (P25c, P25d, P38c/P40c)

The merged 4b plan's §D reserved these probe numbers to this unit and bound
each carried question to its probe. The full rows:

1. **P25c — the projected consultation audience.** The `decisions.inbox`
   projection carries the resolved CONSULTATION audience beside the decider
   designation, threaded through the SAME row/fold/rebuild/filter path P22
   delivered for the decider: the projection row records the decision's
   standing consultations (consultee membership → resolved user), the
   read-path filter admits the consultee's slice exactly as the live
   `decisionVisibleToViewer` widening does, and a REBUILD preserves the
   slice. PROVES: after a consultation is requested, the consultee's
   PROJECTED slice admits exactly that decision; a same-role non-consultee's
   does not; live == projection == rebuild. RED SITE: the `decisions.inbox`
   projection row schema/fold/filter (today decider-only). The projection
   change is additive to the row payload; a rebuild emits zero events (the
   delivered projection discipline).
2. **P25d — the response-side DB eligibility seal's OWN hostile probes.**
   §A's INSERT seal on `DecisionConsultation` has a response-side twin: a
   `DecisionConsultationResponse` INSERT is refused at the DATABASE when its
   parent decision is no longer response-eligible (withdrawn/approved/
   recorded, or unpublished) OR when it is attributed to a responder who is
   not the consultation's named consultee (the recorded actor rule applied to
   the response fact). PROVES: the direct hostile INSERT against an
   ineligible decision, and one attributed to a non-consultee responder, are
   both refused at the DB — the append-only advice register cannot be forged
   past the locked command. RED SITE: the response table's migration seals
   (the service guard alone, without this, is the exact service-only gap the
   4b correction rounds repeatedly closed). Same seal disciplines as §A's
   request seal: try-acquire readiness, locks before judgement.
3. **P38c/P40c — the consultation push families instantiate the §A.3 class
   standing rule.** `decision.consultation_requested` (consultee-targeted)
   and `decision.consultation_responded` (requester-targeted) carry
   per-family eligibility predicates at BOTH the pre-send guard and the
   delivery CLAIM: the consultee predicate re-checks the consultation still
   stands, the decision is still consultee-visible (not withdrawn), and the
   consultee membership is still active; the requester predicate re-checks
   the requester still holds requesting standing (pmc — or, per the
   delivered claim-time shape, the push re-targets to the CURRENT holder set
   where the family defines one, else drops with the recorded cancellation
   mark). PROVES: a consultee removed — or a requester demoted — between
   enqueue and claim never receives decision content (re-targeted or dropped,
   recorded); a still-standing consultation's push SURVIVES unrelated churn.
   RED SITE: the per-family claim predicate registration (today only the
   `decider` family is registered); the pre-send guard's family table.

## §C — The probe table (P23–P27, P41, plus the carried arms)

Every probe runs red-first at the unit's staged baseline (the 4a §D
discipline: an in-branch shape commit carrying contracts/enums/columns with
the behavior deliberately absent, so the probe fails on BEHAVIOR, not on a
missing symbol). Red sites name where today's behavior lives.

| probe | proves | red site / staging |
|---|---|---|
| P23 | consultation round-trip: request → respond, append-only (UPDATE/DELETE sealed), non-blank evidence refused at zod AND the CHECK; ONE response per consultation — a second respond is a deterministic 409 under a different idempotency key, and the direct duplicate insert is refused by the UNIQUE | the two new tables' migration + contracts + the response UNIQUE |
| P24 | consultation moves NO status and NO gate verdict — before/after snapshots byte-equal | `DecisionsService` status CAS surface; the gate reader |
| P25 | visibility widening bounded by eligibility: published-only + open-status at request AND response; the withdrawn-leak refusal (no title/reason reachable); request → withdraw → late-response refused 409; the DB INSERT seal refusing a direct consultation row against a withdrawn AND a draft decision (visibility never widened by a forged row) AND a row whose `requestedById` lacks requesting authority (an inactive or unauthorized requester never fabricates a standing request) | `decisionVisibleToViewer`; the request/response guards + the consultation INSERT seal |
| P25c | the PROJECTED path: the consultee's `decisions.inbox` slice admits exactly the consulted decision, a same-role non-consultee's does not, and a rebuild preserves the slice (live == projection == rebuild) | the `decisions.inbox` projection row schema/fold/filter (decider-only today) |
| P25d | the response-side DB seal: a direct `DecisionConsultationResponse` INSERT against an ineligible decision, and one attributed to a non-consultee responder, both refused at the database | the response table's migration seals |
| P26 | consultation pushes exact: consultee push on request, requester push on response — including the org-admin requester with no membership row | the user-target dispatch delivered by 4b (P21) |
| P27 | the response's child keys make a foreign decision's option unrepresentable: out-of-range index refused at the contract; a foreign option id refused by the composite FK | the response-row candidate keys |
| P38c/P40c | the consultation push families' pre-send AND claim-time standing: a consultee removed — or a requester demoted — between enqueue and claim never receives decision content (re-targeted or dropped with the recorded mark); a still-standing consultee push survives | the per-family predicate registration (decider-only today) + the pre-send guard |
| P41 | eligibility is checked UNDER the decision row lock: the request-vs-withdraw barrier is deterministic in both orderings (request-first → withdraw sees the widening it must revoke nothing for; withdraw-first → request 409) | the consultation command's lock acquisition |

Two delivered-4b disciplines apply to every row above without needing their
own probes, because the tripwires that pin them are already merged and will
fail the implementation PR if skipped: every new command rides the command
ledger with an idempotency key and the §A readiness-lock coverage enumeration
grows by the new commands; every new event joins the shared + sealed
external-effect catalogs.

## §D — Staging, review unit, and order

- **This plan document is the review unit** — one file, docs-only, its own
  exact-head Codex review to a fresh clean +1. STATUS bookkeeping travels in
  its OWN pull request (the PR #335 two-step, made up front: the deferral
  trailer is refused from a STATUS-touching diff). Past the plan-review round
  cap this unit's heads owe `Review-Deferred-To-Probes: phase-6-task-4c` —
  the probes above are exactly the executable deferral targets that trailer
  names.
- **4c implementation follows as ONE PR** only after this plan clears: the
  staged-red shape commit before behavior; the folded-STATUS convention (the
  implementation PR updates `open_pr` in the same change); the
  vision-alignment statement, six-row invariant matrix, and review packet;
  reproduce-first probes; the full gate battery (pnpm check, the integration
  battery on a pristine migrated DB, upgrade-proof — the unit adds a
  migration — and both e2e senders) before its one validated push per round.
- 4c depends on 4b's targeted dispatch and the `Membership(projectId, id)`
  candidate key — both DELIVERED. The review-efficiency budget (20 files /
  1,500 lines) is expected to HOLD for 4c; the PR argues its own case in its
  packet, never by reference to this sentence.
- 4d (architect, forwarding, countersign) is NOT this unit: its plan unit
  follows 4c implementation per the merged §E order, carrying §D obligations
  4–6.

## What carries forward

- The binding ledgers of `docs/reviews/pr-335-convergence.md` and
  `docs/reviews/pr-340-convergence.md` — every decision above annotated with
  its round is carried from them, none reopened.
- 4a's delivered seal network, audience rule, cancellation spine, and
  linkability authority; 4b's delivered decider model, targeted push spine,
  §B.1/§B.2 primitives, and the round-8–11 hardening rules (key before
  judgement; live standing at the act; identity-keyed session reads) —
  extended by reference, never rewritten.
- The owner's recorded intent: decisions decided by the right party, issues
  filed without ceremony, consultation that informs without gating, and an
  architect who countersigns without becoming a bottleneck nobody can route
  around.
