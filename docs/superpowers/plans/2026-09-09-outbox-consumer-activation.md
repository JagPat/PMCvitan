# Outbox consumer activation — the register, its mirror, and the operator protocol

**Docs-only plan unit.** No schema, no migration, no runtime code ships here;
this document specifies them. Extracted from the phase-6 4d plan
(`docs/superpowers/plans/2026-09-07-decision-workflow-4d.md`, PR #572) on
JagPat's instruction, as the first of that plan's four dependency-ordered
units. **This unit has no dependency on the other three. They depend on it**:
4d's obligation set is judged from the ACTIVE consumer set, and the ACTIVE set
is what this register defines. It therefore lands first.

Nothing is re-litigated here. Every finding this material has drawn is carried
forward in the ledger at the end, with its original round and PR named, and the
4d plan keeps its own history intact — this is an extraction, not a
replacement, and no PR is closed or recreated for it.

## The problem

`OutboxConsumerCatalog.active` is a plain writable column. Two defects follow
and both are recorded findings, not hypotheses (#560's review round 1, findings
1 and 2):

1. `registeredAt` as an activation cutoff is a writable timestamp — a direct
   writer could move it past an event and commit without the consumer's
   delivery row.
2. A consumer set inactive for event N and reactivated for N + 1 would have had
   N excluded from expansion "because it postdates registration", stalling its
   ordered cursor at N forever.

The obligation set must be the ACTIVE set, judged from an append-only
attributable fact — never from a timestamp, and never from a column anyone can
edit.

## The register

`OutboxConsumerActivation(consumer, seq, active, reason, actorKind, actorId,
requestToken, at)`, platform-owned, append-only and attributable.

- `(consumer, seq)` UNIQUE; `seq` monotone per consumer.
- `reason` NOT NULL under the `DecisionForward.reason` discipline — zod trims
  and requires length ≥ 1, and the CHECK rejects a value that is empty once
  every ASCII whitespace character is stripped (#560's review round 2,
  finding 4).
- `requestToken` nullable, UNIQUE per `(consumer, requestToken)` — the retry
  identity; see **The operator protocol** below.
- UPDATE and DELETE refused at the row, and the statement-level
  `OutboxConsumerActivation_t4d_no_truncate` registered in `TRUNCATE_SEALS`
  while the table stays outside every sanctioned reset (#560's review round 2,
  finding 2: a direct `TRUNCATE` would have erased the evidence and left the
  mirror unexplained).
- BEFORE INSERT takes the consumer's `OutboxConsumerCatalog` row `FOR UPDATE`
  and requires `NEW.seq = activationSeq + 1` against the stored head.
- AFTER INSERT is the ONLY writer of the mirror: it advances `active` and
  `activationSeq` together (#561's review round 1, finding 5 — without the head
  lock two operator appends could commit seq 2 then seq 1 and leave the mirror
  at the OLDER fact; now they serialize on the catalog row and the loser is
  refused with a stale sequence, never reordered).

`OutboxConsumerCatalog_t4d_rules` freezes `active` and `registeredAt` beside
the rule columns, so the only way to exclude a consumer from an event's
obligation is to append an attributable deactivation row that survives as
evidence, and `registeredAt` plays no part in any seal.

## Every catalog row has a head, from the moment the table exists

The register's migration BACKFILLS A BASELINE FACT FOR EVERY CATALOG ROW —
under its `SET LOCAL` gate, one `seq = 1` row per existing row mirroring that
row's current `active`, `actorKind = 'migration'`, its `reason` naming the
backfill, with each `activationSeq` set to 1.

On upgrade the catalog already holds active consumers (`webpush.notify`,
`decisions.inbox`, …) whose `active` mirror would otherwise have no
attributable row explaining its value — the very thing this register exists to
end — and whose head the no-op below promises to return and could not (#572's
review round 10, finding 3).

**And the backfill runs AFTER every registration this unit's migration
performs, never before** (#572's review round 12, finding 2). Round 10 wrote
the backfill over "catalog rows that already exist" and left a consumer
registered later in the same sequence — `decisions.effects`, registered
INACTIVE — without a head, contradicting the invariant in the same paragraph
that states it. Ordering the backfill last makes the invariant true by
construction for every row whatever its origin: seeded, pre-existing, or
registered by this migration. `upgrade-proof.sh` asserts one baseline row per
catalog row with the mirror equal to it, over a database that already holds
history.

## The operator protocol

`outbox:consumer` is an OPERATOR PROTOCOL, deliberately NOT a ledger command
(#572's review round 8, finding 3). The delivered `CommandScope` admits a
project or an org and nothing else (`platform/commands.ts`), and this register
is GLOBAL: keying its receipt on a tenant would either attach a global mutation
to an arbitrary project, or — scoped per org — let the same activation key
execute once per organisation against a single global `seq`, which is worse
than not using the ledger at all. Inventing a global scope for one operator
action would widen the receipt model for every command in the system to serve
the one command that does not fit it.

**Idempotency comes from a stable REQUEST TOKEN, not from the key and not from
the state.** Two earlier answers failed, and both failures are instructive
enough to keep:

- Round 8 claimed `(consumer, seq)` uniqueness with `ON CONFLICT DO NOTHING`
  made a repeated activation "a no-op by construction". It did not: the
  head-lock trigger requires `NEW.seq = activationSeq + 1`, so a retry that
  re-derives the sequence appends a SECOND fact and a retry that resends its
  original sequence is refused as stale before `ON CONFLICT` is reached. That
  answer confused ORDERING safety, which the head lock does give, with RETRY
  idempotency, which it never did (#572's review round 9, finding 2).
- Round 9 replaced it with a state-only no-op: append nothing when the mirror
  already equals the requested `active`. That is idempotent only while no
  opposite operation intervenes. Activate, lose the response, let another
  operator deactivate, then retry the original request: the mirror reads
  inactive, the retry appends a new activation, and it silently UNDOES the
  later operator's intent rather than replaying its own result (#572's review
  round 12, finding 4).

Codex proposed a stable request token at round 9 and this plan chose the weaker
option and argued for it. The token is the answer.

The command takes the consumer, the intended `active`, its `reason`, and a
`requestToken` the caller generates once and reuses on every retry. Inside ONE
transaction holding that consumer's catalog row `FOR UPDATE`:

1. **A row for `(consumer, requestToken)` exists** → return THAT fact,
   unchanged, whatever the current mirror says. A retry replays its own result
   and never overwrites a later operator's intent.
2. **Otherwise the mirror already equals the requested `active`** → append
   nothing and return the current head. Every consumer has one (above), so this
   branch always has a fact to return.
3. **Otherwise** → append at `activationSeq + 1`, derived under that same lock,
   carrying the token.

`seq` never appears on the operator surface, so the stale-sequence refusal is
unreachable from it; the trigger keeps `NEW.seq = activationSeq + 1` as the
floor under DIRECT writers, which is what it was for. A genuine flip-flop still
appends every fact, because each request carries its own token. The no-op
reports the state truthfully even when another operator set it, and the
append-only attributable row remains the audit trail a receipt would otherwise
have carried — including who actually caused the change, which a no-op must not
overwrite.

This is the shape 4d-iii's own activation already uses (lock, append only if
the head is not already active, verify in the same transaction); the operator
command simply had not adopted it.

## Probes

Executable, and each RED against its own defect alone:

| probe | asserts | RED against |
| --- | --- | --- |
| P-A1 | every catalog row holds exactly one `seq = 1` baseline row with the mirror equal to it, over a database holding history AND over a fresh one | a backfill that seeds only pre-existing rows, and one that runs before this migration's own registrations |
| P-A2 | `outbox:consumer` issued TWICE with the same token appends exactly ONE fact; the mirror and `activationSeq` are unmoved on the second | the state-only no-op and the seq-carrying command |
| P-A3 | activate → (response lost) → a DIFFERENT operator deactivates → the first caller retries with its original token: the retry returns its ORIGINAL fact, the mirror stays INACTIVE, and no fact is appended | round 9's state-only no-op, which re-activates and undoes the later intent |
| P-A4 | activate → deactivate → activate, three distinct tokens, appends three facts | a token check that swallows genuine new intent |
| P-A5 | two concurrent appends under a barrier: they serialize on the catalog row, exactly one commits at `activationSeq + 1`, the loser is refused with a stale sequence and never reordered | the head lock removed |
| P-A6 | a direct UPDATE, a direct DELETE and a `TRUNCATE` on the register are each refused; the mirror is unwritable except by the AFTER INSERT trigger | the seals removed one at a time |

`expandMissingDeliveries`, the delivery rows, the persisted catalog rules and
the obligation set are NOT in this unit — they stay in the 4d plan, which reads
the ACTIVE set from this register.

## Findings carried forward

Every finding this material has drawn, preserved with its origin. Nothing here
is newly claimed as resolved that was not resolved on #572's head `d443aa18`,
except the two marked NEW, which this unit fixes.

| finding | origin | disposition |
| --- | --- | --- |
| `registeredAt` cutoff is a writable column | #560 round 1, finding 1 | the append-only register replaces it |
| a deactivated interval stalls the ordered cursor | #560 round 1, finding 2 | expansion judges the ACTIVE set, not a timestamp |
| a direct `TRUNCATE` erases the evidence | #560 round 2, finding 2 | statement-level seal in `TRUNCATE_SEALS` |
| blank `reason` | #560 round 2, finding 4 | zod trim + CHECK |
| two appends can leave the mirror at the older fact | #561 round 1, finding 5 | catalog row `FOR UPDATE` in BEFORE INSERT |
| a global register cannot be keyed on a tenant scope | #572 round 8, finding 3 | operator protocol, not a ledger command |
| `(consumer, seq)` uniqueness is not retry idempotency | #572 round 9, finding 2 | **superseded** — the state-only answer it introduced is itself corrected below |
| pre-existing catalog rows have no head | #572 round 10, finding 3 | baseline backfill |
| a consumer registered after the backfill has no head | #572 round 12, finding 2 | **NEW** — the backfill runs last |
| the state-only no-op undoes a later operator's intent | #572 round 12, finding 4 | **NEW** — stable request token |

## Review unit

- Base SHA: `15dd8eec` (`main`)
- Scope: one plan document; the outbox consumer activation register, its
  mirror, and the operator protocol
- Split considered: yes — this is unit 1 of 4 extracted from #572. The other
  three (kernel pairing + registers; ChangeRequest provenance + closure
  authority; decision workflow states) stay on #572 and depend on this one.
- Migration/service seam: n/a — docs-only
