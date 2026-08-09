# PR #310 convergence audit — 7B-iii-f, the certification authority chain

Required after two distinct finding-bearing heads. Head 1 `495718d` returned four
findings; head 2 `a8e73d4` returned four more. This is the architectural account of
why, not a list of patches.

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

## Carry-forward

- A **monotonic per-bill lifecycle version** from the server remains the durable fix
  for the equal-timestamp arbitration ambiguity (carried since PR #306). Unchanged by
  this PR; still owed its own unit.
- The §I **evidence-actor** term is still unanswerable before the act, for the reasons
  in the packet. Round 2 does not change that, and no round should try to answer it
  without extracting the draw.
- **For 7B-iii-d**: it adds six commands to the same outbox. Every one of them needs
  the viewed-fact question asked *before* review, not after — that is this audit's
  operative output, and the payments chain is where the money actually leaves.
