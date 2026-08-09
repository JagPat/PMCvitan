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
| Files | 12 |
| Changed lines | 592 |
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

- `pnpm check` — **EXIT 0** (web 683/683 across 45 files, API 780/780 across 57 files, lint + typecheck + both builds clean)
- `commercial-verification.test.ts` **25/25**; `commercial.test.ts` + `commercial-screen.test.tsx` green (133/133 together)
- API integration, focused: `phase5-t7bii-claim-read` **12/12** (5 new preflight probes); `phase5-t5b-certification` **49/49 unchanged**
- Full API integration suite on a pristine migrated database — **86 files / 1033 tests**, exit 0
- No migration, so `upgrade-proof.sh` is not applicable
- Browser e2e runs in CI (the local Chromium build does not match the pinned Playwright revision)

## What is deliberately not here

- **A "you will need an authorisation" prediction** — see the finding above. The
  contract states its own absence rather than leaving it as an omission.
- **The payment half of §I** (`certifierMayNotApprove`) — that rule's grant already
  exists in the schema and is consumed by Task 6A's approval path; surfacing it belongs
  with the payments tab in 7B-iii-d.
- **`amend`** — still wired and still not surfaced, unchanged from 7B-iii-b.
