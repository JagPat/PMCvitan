# 7B-vi — the §H vendor advance surface, parked whole with its finding

The work is parked on **`claude/phase5-task7b-vi-advance-parked` at `be2ba1c`** — the exact head
Codex reviewed. That branch carries the advance read, control, ledger rendering and coalesce key
**complete**, with its open finding named and unfixed. This note is the durable record on `main`;
the branch is the code.

## Why it was parked

PR #317 reached the review lifecycle's limit: **5 finding-bearing heads, 13 findings**, and the
orchestrator's own advice on this head was to split. Two of round 4's three findings and all of
round 5's were the advance, on a unit whose convergence audit had already named the root:
**7B-iv was three workflows wide.** An advance shares nothing with the approve chain — no claim, no
certificate, no approval, no §G bound, no §I rule — except the tab it renders on. Splitting here is
the seam the findings kept pointing at.

## The open finding, and why the obvious fix is the wrong one

**Round 5 (P2)** — `advanceCoalesceKey(vendorId, amount, reason)` still omits `method` and
`reference`. Two legitimate advances to one counterparty for the same amount and reason but a
different method or reference collapse to one key, so the second is treated as an equivalent retry
and silently dropped — on an append-only row the server has no ceiling for.

**Do not fix this by adding `method` and `reference` to the key.** That is a fifth enumeration of
the row-defining facts, and this lineage has now failed at exactly that four times: round 2 named
"re-derive every precondition per rule" and listed three; round 3 found three more; round 4 widened
the advance key by listing amount and reason; round 5 found the two that list omitted. The audit
(`pr-317-convergence.md`) already prescribes the alternative and it applies verbatim here.

**Derive the identity, do not enumerate it.** For an append-only fact with no server-side ceiling,
two dispatches are the same action only if they are the same *payload*. So the coalesce identity
should be a deterministic function of the WHOLE command input — a stable serialisation or hash —
rather than a hand-picked subset. A sixth field added to the advance command then joins the
identity automatically, which is the property every enumeration in this lineage lacked.

Worth checking while doing it: whether any other append-only §M command has the same shape, so the
derived-identity helper lands once rather than per command.

## What ships meanwhile

PR #317 keeps the approve chain and drops the advance surface entirely — no read route, no control,
no key, no store slice. **Only the COMMAND survives**: `POST commercial/advances` pays an advance
and the recovery ceiling is enforced on the server, so no §G bound or §H rule is outstanding.

The LIST read does not survive. `GET commercial/advances` and `listAdvances` were removed with the
control, so nothing can currently hydrate or reconcile advance rows — which means **7B-vi owes the
read as well as the control**, and the read must land first, for the reason it existed in the first
place: the advance coalesce key has no settling read without it, and a key with no release path is
stuck by construction. Getting that ordering wrong is what made this surface a defect in 7B-iv.

Nothing known-broken ships, and nothing is reconstructed from memory: the work is whole on
`claude/phase5-task7b-vi-advance-parked` at the head that was reviewed.
