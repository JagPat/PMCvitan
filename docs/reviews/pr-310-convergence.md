# PR #310 convergence audit — 7B-iii-f, the certification authority chain

Required after two distinct finding-bearing heads, and updated in place on each
subsequent one rather than re-attached. Head 1 `495718d` returned four findings; head 2
`a8e73d4` four more; head 3 `00c42f0` three; head 4 `13c87a4` five. This is the architectural account of why,
not a list of patches.

## The root

**I fix the instance a finding names, not the class it belongs to.**

That is one sentence and it explains six of the eight findings across both rounds.
It is not "I missed some cases" — it is a specific, repeatable failure of scope:
when a finding says *X is wrong here*, I correct *here* and do not ask *where else
is X true?* The evidence is that round 2's sharpest findings are round 1's own
fixes, applied to one member of a set.

| Round 1 fix | What round 2 found |
|---|---|
| F4 — pin the **grant** to the version the approver read, because a queued command replays against whatever is live | Certify and supersede sit in the **same outbox** with the **same exposure**. A queued certify freezes evidence for a version the certifier never saw; a queued supersession replaces a certificate its reason was never written about. I pinned one of three commands and wrote a commit message explaining the principle. |
| F3 — add `sodGrants` to the claim bundle so the read shows the grant whose key it clears | The **button never consulted them**. I added the fact to the contract to justify clearing a key, then left the guard reading only the key. The duplicate the finding was about remained reachable one click later. |

Two more findings are the same root in a weaker form: I built a picker over
`members` without asking *what makes a member a valid choice* (round 2: they must be
able to certify, and the screen must actually load the team). Each is "the thing I
reached for, not the thing the rule requires".

## Why the root produced these findings and not others

The unit's subject is §I — an authority that is **version-pinned** and **names a real
identity**. Both rounds' findings are the same shape: I modelled that authority more
loosely than it is, and every looseness became a command the server is certain to
refuse sitting in a **write-ahead** outbox, reported saved and dropped on reconnect.

That failure mode is the one the last five units have been closing. It recurred here
because I treated "the outbox lies about refusals" as a property of the command I was
looking at rather than of the queue itself. The queue is the invariant; every command
entering it inherits the obligation.

## What changed structurally, not just locally

Round 2's corrections are deliberately written as *class* fixes:

- **Viewed-fact pinning is now applied to all three commands** that can sit in the
  queue across a change — grant (`versionId`), certify (`versionId`), supersede
  (`certificateId`) — each refused server-side on drift rather than silently
  re-pinned. The contract states why it is optional (in-process callers hold no
  rendered fact) so the asymmetry is a decision rather than an oversight.
- **The guard reads the fact, not the key.** Round 1's instinct was to hold the
  coalesce key longer. That is the wrong shape: a key is a proxy for "the effect is
  not visible yet", and once the bundle carries `sodGrants` the effect *is* visible,
  so the button consults it. Holding a key against a read that can now show the truth
  would be a second mechanism disagreeing with the first.
- **Candidate eligibility is derived from the policy** (`ROLE_POLICY['commercial.certify']`),
  not from membership plus intuition. A grant naming someone who cannot certify is an
  authorisation that can never be exercised.

## The finding that was already resolved, and why it is listed anyway

Codex re-raised the round-1 F3 comment (`commercialKeys.ts` — "keep SoD grant keys
until the excused actor sees them") against head 2. The exact-head gate counted **four**
findings, not five, which matches: the contract change resolved the premise (the claim
bundle *can* now show another actor's grant), and round 2's guard closes the residue.

It is recorded here rather than dismissed because the two share a named root and the
protocol is explicit that a shared root must be *said*, not filed as unrelated. The
honest statement is: **F3 was half-fixed in round 1.** The contract half landed; the
consuming half did not, and Codex was right to keep pointing at the same line.

## Round 3 — three findings, and the root sharpens

Head `00c42f0` returned three. They are **not** new roots; they are the SAME root as the
original head's one genuinely correct decision, applied to two places I did not apply it.

The original head *refused* to approximate the §I evidence-actor term, and said why:
a client cannot compute a server authority decision, and approximating one either
over-refuses (blocking what the server allows) or under-refuses (the write-ahead lie).
That reasoning is in the packet and it was right.

Then I built the authorisation picker by approximating two **other** server authority
decisions from client data:

| Round-3 finding | The authority I approximated | From what |
|---|---|---|
| a live grant for the payment half of §I, or one whose approver lost pmc standing, still blocked a replacement | *is this grant usable?* | the existence of a row in `sodGrants` |
| an org owner/admin operating through the documented pmc fallback could never be offered, though the server accepts a grant naming them | *who may be authorised?* | `MembersService.list`, which has no row for them |

So the root's second half: **I refuse to approximate an authority decision only when a
finding has already named that particular one.** The general rule was stated in this
PR's own packet and not applied two screens over.

The fix is the one the codebase already prescribes — `orgs.participant.ts` says it
outright: *a read being representable is not the same as it being legitimate; the OWNER
states the rule.* So `OrgsParticipant.usersWithProjectRoleStanding` enumerates the same
two arms, in the same precedence, as the singular `hasProjectRoleStanding`, and
`SodGrantSummaryDto.usableForCertification` is computed by the certification resolver's
own rule. The client stopped deciding; it now displays.

The third finding is separate and is mine alone: certify's **gate** read the arbitrated
copy while its **payload** was pinned from the claim bundle, so a fresher list enabled a
command pinned to a stale version — my own arbitration mechanism used inconsistently
within one control. Gate and payload now come from one copy.

## Round 4 — the root eats its own fix, and a third half appears

Head `13c87a4` returned five. Two belong to roots already named, and they are the most
damning instances of each:

- **The class root, inside the round that named it.** Round 3 added a list-vs-bundle
  freshness guard to certify and supersede and not to the grant button — while its own
  commit message and this audit were both explaining that fixing one member of a set is
  the recurring failure. Writing the rule down in the same change did not make me apply it.
- **The authority root, one field short.** Round 3 moved "who may be authorised" and "is
  this grant usable" to their owning module, and checked the APPROVER's standing while
  never checking the EXCUSED actor's. The grant is an authority *between two people*; I
  modelled one of them.

The third half is new, and it is the one worth carrying furthest:

**I test the defect a finding names, not the behaviour the fix must preserve.**

Round 3's fix for the gate/payload mismatch was `reading.copy === claim.bill` — object
identity. `arbitrateBillCopy` deliberately returns the LIST object when the two reads
AGREE, so the ordinary case of opening a current claim evaluated as "the bundle is
stale" and **disabled certification entirely**. My round-3 probe asserted only the stale
case. A correctness fix shipped as a functional regression in the workflow it guarded,
and my own probe suite reported green.

The structural response is not "write more probes". It is that **a guard which disables
an action must be probed on the path where the action is still legal** — the negative
case alone cannot distinguish "correctly withheld" from "never available". Round 4's
probe asserts the ordinary path and is RED against round 3.

The mechanism fix follows the same rule as the rest of this audit: `BillReading.source`
NAMES which read won, so a caller asks the concept instead of inferring it from which
object came back. Inference is what made a deliberate tie-break look like staleness.

The fifth finding is a documentation-truth error of exactly the kind these packets exist
to prevent: the scope gate failed, I added `justified-large` to the PR body, and left the
packet asserting the unit was inside budget with the marker unused. Two artefacts about
one diff, disagreeing.

## Round 5 — the review lifecycle reports the head limit, and the unit SPLITS

Head `33b6e68` returned three findings and the lifecycle reported **5 finding-bearing
heads, limit 5**. That changes the answer I gave two rounds ago, and the reversal is
recorded rather than quietly performed: at round 3 I argued splitting would make the
change less safe, and that argument no longer holds.

**What the finding distribution shows.** Across five rounds and 19 findings, the large
majority land on ONE surface — the §I authorisation form: who may be authorised, whether
a standing grant is usable, what facts a queued grant pins, whether the excused actor can
certify, whether a pending transition invalidates it. Certify and supersede generated
comparatively few. A surface that produces findings at that rate needs its own review
unit, which is the thing the head limit is measuring.

**And round 5's P1 is a different KIND of change.** It requires the reviewed status to be
PERSISTED on `SodGrant` and required at resolution — a schema change. Everything else in
this unit is read, contract and UI over already-cleared facts. Carrying a migration into
a unit at its head limit would be the worst of both.

So: `certify` · `supersede` stay here; the §I authorisation surface is parked WHOLE on
`claude/phase5-task7b-iii-f-sod-parked` at `33b6e68` and becomes **7B-iii-h**, carrying
its three open round-5 findings NAMED AND UNFIXED so nothing known-broken ships:

- **R5-1 (P2)** a pending `com:billtx:` transition does not block Authorise, so a grant
  queues behind a transition that invalidates the very facts it pins. The grant's key is
  deliberately per-PERSON (round 2, correctly — two grants for different people are
  independent); that independence was carried one step too far, to transitions that
  change what the grant is pinned to. Needs the dispatcher, not only the screen.
- **R5-2 (P1)** the reviewed status is CHECKED at issue and never PERSISTED, and
  `resolveGrant` consumes by version alone — so a grant authorised on a `submitted`
  claim survives into `verified` and can certify a verdict its approver never saw.
  Schema change.
- **R5-3 (P2)** Supersede stays enabled while paid cash stands against the certificate;
  the payment ledger is already in the claim bundle and the button does not read it.
  *(This one is certify-side and is fixed HERE, not parked — see below.)*

**What honestly remains as a gap in this unit.** A certifier who recorded the evidence is
refused by §I with a message naming `commercial.sod.grant`, and cannot self-serve that
remedy on this screen until 7B-iii-h lands. That is narrower than the 7B-iii-b dead end
the phase paid 25 findings for — there a labour claim could be lodged and never
evidenced, with no path at all; here the common path (a certifier who did not record the
evidence) works end to end and the uncommon one gets an accurate refusal. It is still a
gap, and it is stated in the screen, the packet and here rather than papered over.

## Carry-forward

- A **monotonic per-bill lifecycle version** from the server remains the durable fix
  for the equal-timestamp arbitration ambiguity (carried since PR #306). Unchanged by
  this PR; still owed its own unit.
- The §I **evidence-actor** term is still unanswerable before the act, for the reasons
  in the packet. Round 2 does not change that, and no round should try to answer it
  without extracting the draw.
- **For 7B-iii-d**, this audit's operative output, now two questions rather than one.
  It adds six commands to the same outbox and it is where money actually leaves, so
  before writing any of them, ask of **all six at once**:
  1. *What fact was the user looking at when they decided?* Carry it, and refuse drift
     server-side. (Round 2's root — asked once per command, not once per finding.)
  2. *Which of this screen's decisions are server AUTHORITY decisions?* Every one of
     them is answered by its owning module and displayed, never derived from whatever
     the client happens to hold. (Round 3's root.)
  3. *What must still WORK after this guard?* Probe the legal path, not only the
     refused one — round 4's regression disabled certification outright and every
     existing probe stayed green.
  Both of the first two were already stated somewhere in this repository before they
  were found here — the second verbatim in `orgs.participant.ts`, and the first in this
  very audit while I was violating it. The failure was never not knowing them; it was
  applying them only where a reviewer had pointed.
