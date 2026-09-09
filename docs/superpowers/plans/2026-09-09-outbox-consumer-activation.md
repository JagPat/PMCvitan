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

- `consumer` is a FOREIGN KEY to `OutboxConsumerCatalog(consumer)`, and the
  BEFORE INSERT trigger's catalog lookup is `STRICT` — a `NOT FOUND` is RAISED,
  never treated as a NULL head (#580's review round 1, finding 8). Without both,
  a direct insert naming an unregistered consumer finds no catalog row, compares
  `NEW.seq` against a NULL `activationSeq` under three-valued logic — where
  `1 = NULL + 1` is NULL, not false, so a non-STRICT lookup RAISES NOTHING —
  and leaves an orphan activation with no mirror; the consumer's later
  registration then either starts from an unexplained state or collides with
  that history on `(consumer, seq)`. The FK refuses the row at statement end;
  the STRICT raise refuses it at the trigger, with the message that names the
  unknown consumer. Both are stated because the trigger reads the row anyway
  and a reader must not have to infer which one fires.
- `(consumer, seq)` UNIQUE; `seq` monotone per consumer.
- `reason` NOT NULL under the `DecisionForward.reason` discipline — zod trims
  and requires length ≥ 1, and the CHECK rejects a value that is empty once
  every ASCII whitespace character is stripped (#560's review round 2,
  finding 4).
- `actorId` NOT NULL under the SAME whitespace discipline, with `actorKind` in
  a closed set (`'operator'`, `'migration'`, `'registration'`) (#580's review
  round 1, finding 5). For the two non-operator kinds `actorId` is a NAMED
  CONSTANT system actor under the delivered `systemActor` convention (the
  migration's own name; the registering path's), so an implementer does not have
  to invent one and no row carries a blank. For `'operator'` it is the identity
  the caller supplies. The identity is OPERATOR-DECLARED, not authenticated:
  this protocol has no request context to derive one from, exactly as
  `outbox:retry` has none, and the plan says so rather than implying an
  authentication this unit does not build. What the register guarantees is that
  a state-changing fact always CARRIES an identity and never an invented or
  blank one.
- `requestToken` is nullable at the column and REQUIRED BY CHECK for every kind
  that CAN RETRY, which is two of the three: `actorKind IN ('operator',
  'migration') → requestToken IS NOT NULL`, and `'registration'` alone carries
  none (#580's review round 2, finding 2). Round 1 wrote the rule as
  "operator" and then, four paragraphs later, gave 4d-iii's migration step "a
  fixed token of its own (its migration name)" — an instruction that its own
  CHECK rejects. That is the SAME self-cancelling shape as the `registeredAt`
  sentence round 1 was fixing, reintroduced in the same commit, and the repair
  is the same: say which property each kind has and why. A MIGRATION retries —
  `ALWAYS_EXECUTE` re-runs it on every baseline path — so it needs the replay
  identity exactly as an operator does, and without one a re-run after an
  operator's deactivation would append again and silently re-activate the
  consumer, which is the lost-response defect wearing a migration's hat. Its
  token is the migration's own name, stable across every replay, and the UNIQUE
  is `(consumer, requestToken)`, so one migration writing a baseline row per
  catalog row uses one token value and contends with nothing. A REGISTRATION
  cannot retry: the trigger fires from a catalog row's INSERT, the catalog's
  primary key admits that INSERT exactly once for a consumer, and a second one
  is not a retry but an error the key already refuses. The UNIQUE is `(consumer, requestToken)`, which
  in PostgreSQL admits any number of NULLs, so the baseline rows the migration
  and the registration trigger append never contend on it. The row also carries
  the CANONICAL REQUEST the token was minted for (`active`, `reason`,
  `actorId`), so a replay can be CHECKED rather than assumed; see **The operator
  protocol**. Stating the nullability as one rule keeps this from reading like
  the contradiction finding 9 caught elsewhere: the token is mandatory for the
  writer that retries and absent for the writers that cannot.
- UPDATE and DELETE refused at the row, and the statement-level
  `OutboxConsumerActivation_t4d_no_truncate` registered in `TRUNCATE_SEALS`
  while the table stays outside every sanctioned reset (#560's review round 2,
  finding 2: a direct `TRUNCATE` would have erased the evidence and left the
  mirror unexplained). **The ONE admitted deletion is the CATALOG ROW'S OWN
  CASCADE** (#580's review round 2, finding 4): the FK carries `ON DELETE
  CASCADE` and the seal ADMITS that nested delete — arriving at trigger depth
  from the owning `OutboxConsumerCatalog` row — while a direct `DELETE` stays
  refused, exactly as `UserIdentity` is disposed against its owning `User` row
  in the 4d plan. Without it, the catalog-INSERT trigger below turns every
  consumer into a parent with an undeletable child, and four DELIVERED
  teardowns break: `outbox-scanner.test.ts` (`afterAll` line 51, `afterEach`
  line 65) and `outbox-reliability.test.ts` (`afterAll` line 26, `afterEach`
  line 32) each `deleteMany` their ad-hoc catalog rows, and their own comment
  says why — a leaked row "poisons later runs" of the SHARED test database. The
  FK would refuse those deletes, the child could not be removed either, and the
  suites would fail at teardown and leave exactly the pollution they exist to
  prevent. This costs the register nothing it was protecting: the evidence
  explains a consumer's `active` mirror, and when the catalog row is gone there
  is no mirror left to explain. The sanctioned reset needs NO new step and no
  new disabled name, and P-A6 asserts both halves — the direct delete refused,
  the catalog row's delete taking its activations with it.
- BEFORE INSERT takes the consumer's `OutboxConsumerCatalog` row `FOR UPDATE`
  and requires `NEW.seq = activationSeq + 1` against the stored head.
- AFTER INSERT is the ONLY writer of the mirror: it advances `active` and
  `activationSeq` together (#561's review round 1, finding 5 — without the head
  lock two operator appends could commit seq 2 then seq 1 and leave the mirror
  at the OLDER fact; now they serialize on the catalog row and the loser waits,
  re-reads the committed head and appends after it, never reordered).

`OutboxConsumerCatalog` gains `activationSeq` (INTEGER NOT NULL DEFAULT 0), and
`OutboxConsumerCatalog_t4d_rules` freezes `active`, `activationSeq` and
`registeredAt` beside the rule columns, so the only way to exclude a consumer
from an event's obligation is to append an attributable deactivation row that
survives as evidence.

**The mirror's write seam is narrow and named** (#580's review round 1,
finding 6). A rules trigger that froze `active` unconditionally would roll back
every activation, since the register's own AFTER INSERT is the writer that must
move it; one broadly bypassable would leave the column open to the direct
updates this register exists to end. So the rules trigger admits an UPDATE
touching `active`/`activationSeq` on exactly one condition: it arrives NESTED —
`pg_trigger_depth() > 1` — AND under the transaction-local marker
`vitan.outbox_activation_applying` that the activation register's AFTER INSERT
sets around its own statement and clears after it. Every depth-1 UPDATE of
either column is refused whatever else it carries, and a nested update from any
OTHER trigger is refused for want of the marker. This is the depth-and-flag
doctrine the 4d registers already use for their own writer seals, applied here
to one column pair.

**`registeredAt` is FROZEN and selects NOTHING — two statements, both true**
(#580's review round 1, finding 9). An earlier wording said the rules trigger
freezes it and then that it "plays no part in any seal", which reads as an
instruction cancelling itself. They are about different things: the timestamp
is IMMUTABLE after insert (the rules trigger refuses any UPDATE of it, which is
what makes the original defect — moving the cutoff past an event — unwritable),
and it is consulted by NO obligation rule (the ACTIVE set comes from this
register, never from a date, which is what makes it harmless to keep). Both are
probed: a direct UPDATE of `registeredAt` refused, and an event's obligation set
unchanged when the column differs.

## Every catalog row has a head, from the moment the table exists

**The head is created by the catalog row's own INSERT, not by a migration that
happens to see it** (#580's review round 1, finding 4). The migration installs
an AFTER INSERT trigger on `OutboxConsumerCatalog` that appends the row's
`seq = 1` baseline in the same statement — mirroring the value the INSERT gave
`active`, `actorKind = 'registration'`, its `reason` naming the registering
path — so EVERY future catalog row has a head by construction, whoever creates
it. The writer that made this necessary is the supported one: bootstrap's
`syncConsumerCatalog()` (`apps/api/src/platform/outbox/registry.ts`) creates a
row for every newly compiled consumer on every deploy, with no `active`
supplied so the column default applies. A newly compiled consumer would
otherwise arrive with an `active` mirror and no fact explaining it — the exact
condition this register exists to end — and the operator protocol would have no
head to replay.

**And this is round 12's own rule, one level up.** Round 12 of #572 found this
same shape and answered it by ORDERING the migration's steps: run the backfill
last, after this migration's own registrations. That made the invariant true for
the rows one migration could see and left every row created after it — which is
enumerating the ROWS a writer touches instead of the OPERATIONS that create
them. The trigger keys on the operation, so no future writer has to be listed.

The register's migration still BACKFILLS A BASELINE FACT FOR EVERY CATALOG ROW
THAT PRE-DATES THE TRIGGER — under its `SET LOCAL` gate, one `seq = 1` row per
such row mirroring that row's current `active`, `actorKind = 'migration'`, its
`reason` naming the backfill, with each `activationSeq` set to 1.

On upgrade the catalog already holds active consumers (`webpush.notify`,
`decisions.inbox`, …) whose `active` mirror would otherwise have no
attributable row explaining its value — the very thing this register exists to
end — and whose head the no-op below promises to return and could not (#572's
review round 10, finding 3).

**The trigger is installed BEFORE this migration's own registrations, and the
backfill runs after them** (#572's review round 12, finding 2; #580's review
round 1, finding 4). Round 10 wrote the backfill over "catalog rows that
already exist" and left a consumer registered later in the same sequence —
`decisions.effects`, registered INACTIVE — without a head, contradicting the
invariant in the same paragraph that states it. With the trigger installed
first, this migration's own registrations get their heads the same way every
future one does, and the backfill covers only what pre-dates the trigger; the
ordering is then belt-and-braces rather than the mechanism. `upgrade-proof.sh`
asserts one baseline row per catalog row with the mirror equal to it, over a
database that already holds history, and P-A1 drives a NEW consumer through
`syncConsumerCatalog()` after the migration and asserts its head exists.

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

The command takes the consumer, the intended `active`, its `reason`, the
OPERATOR IDENTITY (`actorId`, validated non-blank at zod and at the CHECK —
#580's review round 1, finding 5), and a `requestToken` the caller generates
once and reuses on every retry. Inside ONE transaction holding that consumer's
catalog row `FOR UPDATE`, there are exactly TWO branches:

1. **A row for `(consumer, requestToken)` exists.** Its stored canonical
   request — `active`, `reason`, `actorId` — is compared with this call's. Equal
   → return THAT fact, unchanged, whatever the current mirror says: a retry
   replays its own result and never overwrites a later operator's intent.
   DIFFERENT → **REFUSED**, naming the conflict, under the same-key/different-
   request contract the command kernel already states (`docs/ARCHITECTURE.md`,
   the Phase-2 Task-5 bullet: *"same key + same request replays; same key +
   different request → 409"*) (#580's review round 1, finding 3). Without the
   comparison, a token accidentally reused for a later deactivation — or the
   same token supplied by a second operator — reports the EARLIER activation as
   though it were this request's result, which is a lie about what the register
   holds and about who caused it.
2. **Otherwise** → append at `activationSeq + 1`, derived under that same lock,
   carrying the token, the identity and the canonical request.

**THE STATE-ONLY BRANCH IS GONE, not narrowed a third time** (#580's review
round 1, finding 2). Round 9 introduced "append nothing when the mirror already
equals the requested `active`"; round 12 of #572 showed it reverses a later
operator after a lost response and answered with the token; and this round shows
the token does not survive that branch, because a request that appends nothing
records no token. Concretely, with a consumer already active: operator A
requests activate with token T → the old branch 2 appends nothing; A's response
is lost; operator B deactivates; A retries T → step 1 finds no row for T and the
call falls through to the append, RE-ACTIVATING and undoing B — the very
interleaving the token was adopted to stop, reproduced through the branch that
was left beside it. One state-only branch has now produced a finding in three
consecutive rounds, so the answer is to delete it rather than to add a fourth
condition: **every distinct operator request appends its fact**, including one
that confirms the state it found. The register becomes the record of every
REQUEST rather than of every CHANGE, which is what "attributable" has to mean
if a retry is to find its own row — and it costs one row per redundant request,
which is the correct price for an audit register.

A confirming append moves `activationSeq` and rewrites `active` to the value it
already held; the mirror's VALUE is unchanged and its head now names the
operator who asked for it. `seq` never appears on the operator surface, so the
stale-sequence refusal is unreachable from it; the trigger keeps
`NEW.seq = activationSeq + 1` as the floor under DIRECT writers, which is what
it was for. A genuine flip-flop still appends every fact, because each request
carries its own token, and retries never append, because they replay theirs.

4d-iii's own `decisions.effects` activation runs the SAME two branches, and the
sweep behind this round corrects it too: it is a MIGRATION step with a fixed
token of its own — its migration name, which the register's CHECK REQUIRES of
the `'migration'` kind for exactly this reason (#580's review round 2,
finding 2) — so a replayed migration finds that token
and replays its fact instead of appending a second one, and a
`decisions.effects` an operator deactivated between the first run and the replay
is NOT silently re-activated by it. The earlier wording — "append only if the
head is not already active" — was the state-only branch under another name, and
it inherits the same defect for the same reason.

## Probes

Executable, and each RED against its own defect alone:

| probe | asserts | RED against |
| --- | --- | --- |
| P-A1 | every catalog row holds exactly one `seq = 1` baseline row with the mirror equal to it, over a database holding history AND over a fresh one — **AND a consumer created AFTER the migration by `syncConsumerCatalog()` at bootstrap holds one too**, its `active` default mirrored and its `actorKind = 'registration'` | a backfill that seeds only pre-existing rows; one that runs before this migration's own registrations; and the ordering-only answer, under which the bootstrap-created row has no head at all |
| P-A2 | `outbox:consumer` issued TWICE with the same token and the SAME request appends exactly ONE fact; the mirror and `activationSeq` are unmoved on the second | the state-only no-op and the seq-carrying command |
| P-A3 | activate → (response lost) → a DIFFERENT operator deactivates → the first caller retries with its original token: the retry returns its ORIGINAL fact, the mirror stays INACTIVE, and no fact is appended — driven in BOTH starting states, from inactive AND **from a consumer that was ALREADY ACTIVE when the first request arrived** | round 9's state-only no-op, which re-activates and undoes the later intent, and the token-with-a-state-branch answer, which passes the first arm and fails the second because the confirming request recorded no token (#580's review round 1, finding 2) |
| P-A4 | activate → deactivate → activate, three distinct tokens, appends three facts | a token check that swallows genuine new intent |
| P-A5 | two concurrent operator requests with DISTINCT tokens, both flipping, staged as a PRE-LOCK rendezvous (#580's review round 2, finding 3 — round 1's staging said "both read the head before either commits", which the CORRECT implementation cannot do, because it takes the catalog row `FOR UPDATE` BEFORE that read: A would hold the lock at the barrier and B could never reach it, so the probe deadlocked against the very code it certifies): A opens, takes the lock, appends and HOLDS without committing; B then starts and is observed BLOCKED on that row in `pg_stat_activity`; A commits; B proceeds, reads the head A committed, and appends after it. BOTH facts commit, at `activationSeq + 1` and `+ 2` in the order they serialized, and the terminal mirror is the SECOND operator's intent | the head lock removed — without it both writers read the same head, both derive `+ 1`, the unique index admits one and REFUSES the other, and an operator's request is lost with the terminal state left at the first writer's. (RED by construction, unlike the earlier assertion — "exactly one commits at `activationSeq + 1`" — which `(consumer, seq)` UNIQUE guarantees with or without the lock, so it could not fail against lock removal at all: #580's review round 1, finding 7) |
| P-A6 | a direct UPDATE, a direct DELETE and a `TRUNCATE` on the register are each refused, while DELETING THE CATALOG ROW takes its activation rows with it and the four delivered outbox teardowns (`outbox-scanner.test.ts` 51/65, `outbox-reliability.test.ts` 26/32) run unchanged and leave nothing behind; a direct UPDATE of `OutboxConsumerCatalog.active`, `activationSeq` or `registeredAt` refused at depth 1, one nested from another trigger without the marker refused, and the register's own AFTER INSERT admitted — while an event's obligation set is unchanged when `registeredAt` differs | the seals removed one at a time; an unconditional catalog freeze (under which every activation rolls back) and a depth-only one (under which any nested writer passes) |
| P-A7 | the WHITESPACE CHECK at the database boundary: a raw `INSERT` whose `reason` is a single space, a tab, a vertical tab, a form feed, a carriage return or a newline is refused, one arm of the CHECK removed at a time; the same for `actorId`; and the zod layer refused independently | a `btrim()`-only check, which passes every zod probe and still persists a tab-only reason from a direct writer (#580's review round 1, finding 10) |
| P-A8 | a raw `INSERT` naming a consumer with NO catalog row is refused — by the trigger's STRICT `NOT FOUND` raise, and again by the FK with the trigger disabled — and no orphan row survives | the non-STRICT lookup, under which the row commits with no mirror and a later registration collides with its history |
| P-A9 | a retry carrying a KNOWN token with a DIFFERENT `active`, a different `reason` or a different `actorId` is REFUSED naming the conflict, while the identical request replays; and an append with a blank or whitespace-only `actorId` is refused | a replay branch keyed on the token alone, which reports the earlier fact as this request's result |

`expandMissingDeliveries`, the delivery rows, the persisted catalog rules and
the obligation set are NOT in this unit — they stay in the 4d plan, which reads
the ACTIVE set from this register.

## Review round 2 (head `feea630d`) — four findings, and all four are round 1's own corrections

| finding | the answer |
|---|---|
| 1 (P1) STATUS declares this unit current and leaves `phase_plan` on the COMPLETED 4c document, so after the merge the resolver returns `task:4` and the runner opens finished work | `phase_plan` names the plan this change lands — the only 4d plan in this tree, which is what `autonomous-status-state.test.mjs` requires of it |
| 2 (P2) the register requires no token of the system kinds while 4d-iii's migration step is given "a fixed token of its own" — an instruction its own CHECK rejects | the CHECK covers every kind that CAN RETRY: `operator` AND `migration`. A migration retries (`ALWAYS_EXECUTE`), so it needs the replay identity for the same reason; `registration` cannot, because the catalog's primary key admits its INSERT once |
| 3 (P2) round 1's P-A5 staging requires both requests to read the head before either commits, which the CORRECT implementation forbids — it locks before reading, so the probe deadlocks against the code it certifies | staged as a PRE-LOCK rendezvous: A holds the lock uncommitted, B is observed BLOCKED in `pg_stat_activity`, A commits, B reads the committed head and appends after it |
| 4 (P2) the catalog-INSERT trigger makes every consumer a parent with an undeletable child, and four delivered outbox teardowns `deleteMany` their ad-hoc catalog rows — they would fail and poison the shared test database | the FK carries `ON DELETE CASCADE` and the seal admits that nested delete, exactly as `UserIdentity` is disposed against its owning `User` row; a direct DELETE stays refused and the reset needs no new step |

**All four are round 1's own corrections, and the root cause is that I did not
run my own check over my own new material.** The three questions this plan's
sibling states — which unit installs this arm, what does it read and where does
each value come from, and which DELIVERED writers must it still admit — were
written the same hour as round 1's batch, and round 1 added three obligations
without asking any of them of the new work: a trigger that creates a child row
for every catalog INSERT (finding 4 is its third question — the delivered
teardowns), a CHECK keyed on `actorKind` (finding 2 is its second — what the
migration step needs to exist), and a barrier probe (finding 3 is a fourth
question the others imply and none of them asks).

So the check gains that fourth question, and it is the one a plan document is
most able to get wrong, because nothing runs it:

> **Can the PROBE be executed against the correct implementation?** A probe
> states an interleaving; the implementation states a lock order. Walk the probe
> against the code it certifies, step by step, and ask what each session is
> holding at each barrier. A probe that deadlocks against correct code is not a
> weak proof, it is not a proof — and it fails in a way that reads like a bug in
> the thing it was meant to certify.

Finding 4 is the shape #571 spent four rounds on — a DELETE-refusing seal that
breaks a reset — and it reappeared here within a day, from a trigger added to
fix something else. The lesson that transfers is not about deletes: it is that
adding a PARENT-CHILD relationship to a table other code already deletes is a
change to that other code, whether or not it is edited.

## Review round 1 (head `733c4b92`) — ten findings, all folded here after the audit

Held as a set and the whole protocol walked before anything was written, then
corrected in ONE batch. Three of the ten are this unit's own answers failing,
and they share a root cause worth naming.

**The invariant was stated over a SET and enforced over one writer's rows.**
"Every catalog row has a head" was made true by ordering a migration's steps;
"a token identifies a request" was made true on the path that appends and left
untrue on the path that does not. Both are the same error: an invariant is
enforced at the OPERATIONS that can violate it — a catalog row's INSERT,
whoever performs it, and every operator request, whether or not it changes
anything — never at the rows one writer happens to touch. That is #572's round-12
rule (*enumerate the operations, not the columns*) one level up, and it is why
the fixes here are a trigger and a deleted branch rather than another ordering
argument.

**The state-only branch has now produced a finding in three consecutive rounds**
— round 9 introduced it, round 12 showed it reverses a later operator, round 1
here shows the token cannot survive it. A condition that keeps failing on a new
axis is not under-specified, it is wrong, and the third round is where it gets
deleted instead of narrowed.

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
| the state-only no-op undoes a later operator's intent | #572 round 12, finding 4 | **superseded** — the token answer it introduced kept the state branch beside it, and that branch is the finding below |
| the token is never recorded on a same-state request, so the retry re-activates | #580 round 1, finding 2 | **FIXED** — the state-only branch is DELETED; every distinct request appends |
| a token replay is unbound to its request or its actor | #580 round 1, finding 3 | **FIXED** — the canonical request is stored and compared; a mismatch is refused |
| catalog rows created after the migration by `syncConsumerCatalog()` have no head | #580 round 1, finding 4 | **FIXED** — an AFTER INSERT trigger on the catalog appends every row's baseline |
| the command input carries no operator identity | #580 round 1, finding 5 | **FIXED** — `actorId` required and validated; declared, not authenticated, and said so |
| the mirror's write seam is unspecified | #580 round 1, finding 6 | **FIXED** — depth + `vitan.outbox_activation_applying` marker, depth-1 refused |
| P-A5 could not be RED against lock removal | #580 round 1, finding 7 | **FIXED** — re-designed around an outcome that depends on serialization |
| an activation for an unknown consumer leaves an orphan | #580 round 1, finding 8 | **FIXED** — FK + STRICT `NOT FOUND` raise; P-A8 |
| `registeredAt` frozen AND "in no seal" — an instruction cancelling itself | #580 round 1, finding 9 | **FIXED** — both statements separated and both probed |
| no database-boundary probe for the whitespace CHECK | #580 round 1, finding 10 | **FIXED** — P-A7, one CHECK arm removed at a time |
| this task-bearing unit is not recorded in STATUS | #580 round 1, finding 1 | **FIXED** — `open_pr: 580`, `task_state: in_progress`, the four-unit split named |
| `phase_plan` still named the completed 4c plan | #580 round 2, finding 1 | **FIXED** — it names the plan this change lands |
| the migration's replay token is refused by the register's own CHECK | #580 round 2, finding 2 | **FIXED** — the CHECK covers every retry-capable kind |
| P-A5's staging deadlocks against the correct implementation | #580 round 2, finding 3 | **FIXED** — pre-lock rendezvous with the blocked observation |
| the catalog-INSERT trigger breaks four delivered outbox teardowns | #580 round 2, finding 4 | **FIXED** — `ON DELETE CASCADE` with the seal admitting the nested delete |

## Review unit

- Base SHA: `15dd8eec` (`main`)
- Scope: this plan document + `docs/STATUS.md`, which records the unit while it
  is open (#580's review round 1, finding 1); the outbox consumer activation
  register, its mirror, and the operator protocol
- Split considered: yes — this is unit 1 of 4 extracted from #572. The other
  three (kernel pairing + registers; ChangeRequest provenance + closure
  authority; decision workflow states) stay on #572 and depend on this one.
- Migration/service seam: n/a — docs-only
