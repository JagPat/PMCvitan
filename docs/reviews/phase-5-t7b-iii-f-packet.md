# Phase 5 Task 7B-iii-f — the certification authority chain (§F/§I)

Branch `claude/phase5-task7b-iii-f`, from `main` `b80f0cd`.

## Vision alignment

Certification is the act that turns a verified claim into money someone is owed.
§I says the actor who recorded the evidence may not be the actor who certifies it,
and that the exception to that rule must be *named* rather than silent — a two-person
site must still be able to operate, but never by quietly relaxing the rule.

This unit puts that whole shape on one screen: certify, the authorisation that
excuses it, and the supersession that corrects it. The three are one unit because
`certify`'s only blocking failure mode is separation of duties and `sod-grant` is its
remedy — split apart, a user meets a button whose sole failure they have no way to
clear, which is exactly the dead end 7B-iii-b was split to avoid.

## Scope

| | |
|---|---|
| Files | 14 |
| Changed lines | 700 (including the round-1 correction) |
| Budget | 20 files / 1,500 lines — inside, marker not used |
| Schema / migration | none |
| New server behaviour | none (one grant rule extracted and shared; two inline `from:` literals replaced by shared constants the services read) |

## The finding that shaped this unit

The handoff (PR #309) asked for a preflight covering all five SoD outcomes. **That is
not achievable, and building an approximation would be worse than building nothing.**
Reading the certify path is what established it, and the reasoning is the deliverable
as much as the code:

`assertSegregation` reads `phase5_t5_evidence_actors(projectId, certificateId)` — a
SQL function over the consumption rows the certificate has **already frozen**. The
freeze is decided by `drawMeasurements`/`drawAcceptances`, which run over rows locked
in a total order *inside* the certification transaction. So "is this caller an
evidence actor?" — i.e. "is an authorisation needed at all?" — has no answer before
the act.

Three ways to answer it anyway were considered and rejected:

| Option | Why not |
|---|---|
| A prospective SQL twin of `phase5_t5_evidence_actors` | A **second implementation** of a rule whose recorded history is two implementations drifting apart, where only the one a finding named ever got fixed. The service's own comments say so. |
| A rolled-back dry-run certification | A heavy, side-effecting write dressed as a read. |
| "Every actor on the line" as a conservative superset | It **over-refuses**. An actor whose evidence an earlier live certificate already consumed is not in this certificate's evidence, so this blocks certifications the server would accept — as wrong as offering ones it refuses, just in the other direction. |

**So the preflight carries only what is exactly knowable**, and the contract documents
the absent term the way `lib/measurement.ts` documents its missing EFFORT cap. The
remaining outcome stays a server refusal — and the answer to a refusal that cannot be
predicted is to make it **legible with its remedy reachable**, not to guess it. That
is why the authorisation form sits directly beside the certify button.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | three commands with three authorities; the outbox is durable and the dispatcher reachable without the screen, so a screen-only gate queues an unauthorised money command and reports it saved | `COMMERCIAL_OP_PERMISSION` reads `commercial.certify` / `commercial.sod.grant` per command + `mayCertify`/`mayGrantSod` on screen; probe "each command carries its OWN authority"; off-pilot inertness probe |
| civil-time-lifecycle | a grant is pinned to the claim VERSION the approver saw; an amendment must strand it rather than silently carrying permission to a claim they never looked at | API probe 6d — the read reports `stale-version` after an amend; RED when version-pinning is dropped |
| concurrency-idempotency | two transitions on one claim in flight; and, inversely, two independent authorisations coalesced into one | certify/supersede join the `com:billtx:` conflict rule by key shape; the grant is keyed by (claim, excused person) — probes for both, each RED under its own mutation |
| data-integrity-conservation | n/a — no schema, no migration, no fold touched. The grant resolution is extracted, not rewritten | the existing certification suite is **49/49 unchanged**, which is the evidence the extraction is behaviour-preserving |
| offline-reconciliation | a grant's key released by a read that cannot show it | `readClearsKey` — the CLAIM bundle owns it (it carries `certifyPreflight`), under the hoisted `observedWrite`; probe covers both polarities and the wrong-claim case |
| ui-server-parity | the screen offering a transition the service refuses; or the read and the command disagreeing about a grant | `BILL_CERTIFY_FROM` shared and read by the service; `BILL_STATUSES_PAST_CERTIFICATION` already shared; API probe 6e — the preflight names the grant the command then consumes |

## Evidence

### Reproduce-first, mutation-verified

Every probe was verified RED by removing exactly its own mechanism, restored before
the next. Server and client mutations listed together:

| Mutation | Probe that went RED |
|---|---|
| preflight ignores the caller and reports any grant on the claim | 6c — "it is the CALLER's state" |
| version-pinning dropped from the grant lookup | 6d — "an amendment strands the authorisation" |
| the read **re-derives** the rule, forgetting the approver-standing filter (the plausible drift this sharing exists to prevent) | 6d |
| preflight reports `live` without saying which grant | 6b and 6e |
| the SoD grant keyed on the CLAIM instead of the person | "keyed by the PERSON excused, so two are independent" |
| the claim read no longer makes a grant visible | "the CLAIM read is what makes an authorisation visible" |
| certify/supersede dropped from the claim-wide conflict rule | "certify and supersede join the CLAIM-wide transition conflict" |

### Gates

- `pnpm check` — **EXIT 0** (web 689/689 across 45 files, API 780/780 across 57 files, lint + typecheck + both builds clean)
- `commercial-verification.test.ts` **27/27**; `commercial-screen.test.tsx` **64/64**; `commercial.test.ts` green
- API integration, focused: `phase5-t7bii-claim-read` **16/16** (5 preflight + 4 correction probes); `phase5-t5b-certification` **49/49 unchanged**
- Full API integration suite on a pristine migrated database — **86 files / 1037 tests**, exit 0, run over the CORRECTION head (the initial head's own run was 86/1033; the +4 are this round's API probes)
- No migration, so `upgrade-proof.sh` is not applicable
- Browser e2e runs in CI (the local Chromium build does not match the pinned Playwright revision)

## Round 1 — four Codex findings on head `495718d`, all real, all mine

Three share one root, and naming it is the point: **I modelled a SoD authorisation
as a bare (claim, person) fact, when §I makes it a version-pinned authority naming a
real identity.** Each looseness put a command the server is certain to refuse into the
durable write-ahead outbox — reported saved, dropped on reconnect. That is the failure
shape the last four units have been closing, reintroduced by me in the unit that
closes it for certification.

| # | Finding | Fix |
|---|---|---|
| F1 | the excused person was **free text** — a display name, a typo, or the approver's own id all queued a grant | a picker over the ACTIVE team minus the caller. The caller's own id must come from the server (`certifyPreflight.callerActorId`), because the session carries a role and a name and never an actor id — smaller and more honest than threading a user id through every sign-in path |
| F2 | `resolveActor(this.prisma, …)` ran a root-client `user.findUnique` **inside** the repeatable-read claim transaction — a read outside the snapshot the method exists to assemble, and a second connection checkout that can self-block | the call is gone; `actorId` is `user.sub`, and the display name it resolved was unused |
| F3 | **my own doctrine, broken in the PR that hoisted it.** `certifyPreflight` answers for the CALLER, so an approver reloading after authorising Ravi saw nothing of Ravi's grant while its pending key cleared, re-arming the form for a duplicate | fix the CONTRACT, not the key — the bundle carries the claim's live `sodGrants`, so the read genuinely shows what it clears. §I's rule is that the exception is NAMED rather than silent, so a register that hid it was wrong on its own terms |
| F4 | a grant is version-pinned so permission never carries to a claim the approver never saw — but the server resolved "live" at EXECUTION, and through the outbox those are different moments | the command carries the viewed `versionId`; the server REFUSES drift rather than re-pinning. Optional in the schema and checked when present, so in-process callers are unchanged — the asymmetry is stated in the contract |

Seven mutations, each reddening exactly its own probe. **One probe was rewritten after
passing under mutation:** "Authorise stays disabled" used only valid values, so it never
exercised the eligibility term; the probe that does is a chosen member *leaving the
project* with the draft still holding their id.

## What is deliberately not here

- **A "you will need an authorisation" prediction** — see the finding above. The
  contract states its own absence rather than leaving it as an omission.
- **The payment half of §I** (`certifierMayNotApprove`) — that rule's grant already
  exists in the schema and is consumed by Task 6A's approval path; surfacing it belongs
  with the payments tab in 7B-iii-d.
- **`amend`** — still wired and still not surfaced, unchanged from 7B-iii-b.
