# Outbox consumer activation — the register, its mirror, and the operator protocol

**Docs-only COMPANION DOCUMENT of the phase-6 4d plan unit**
(`docs/superpowers/plans/2026-09-07-decision-workflow-4d.md`, PR #572). No
schema, no migration, no runtime code ships here; this document specifies them.

**Read this first if you are reading the history below.** This material was
extracted from the 4d plan on JagPat's instruction as unit 1 of four
dependency-ordered units, reviewed on its own as PR #580 for four rounds, and
then returned to the 4d unit on JagPat's later instruction — "close #580 and
take the whole 4d plan back to one unit" (4d plan, round 22). So every sentence
below that speaks of "this unit" as something that "lands first", or of PR #580,
or of three sibling units, is describing the interval in which it was reviewed
separately. It is left standing rather than rewritten, because it is what each
round's findings were raised against and answered on. What is true NOW: this
document and the 4d plan are ONE review unit and land in ONE commit; the
dependency order they describe is unchanged and is enforced by migration order
inside that unit — 4d-i installs the register, its seals and its baseline
backfill, 4d-ii registers `decisions.effects` into the catalog, 4d-iii appends
the activation after the drain.

Nothing is re-litigated here. Every finding this material has drawn is carried
forward in the ledger at the end, with its original round and PR named, and the
4d plan keeps its own history intact. No PR was closed or recreated to reset a
review count, and no finding was dropped in either direction — extraction or
return.

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
  token is the migration's own name, stable across every replay, and under the
  uniqueness stated below one migration writing a baseline row per catalog row
  uses one token value and contends with nothing (#580's review round 4,
  finding 3: this sentence used to state a `(consumer, requestToken)` UNIQUE of
  its own, which round 3 superseded and did not delete — TWO constraints, and
  the narrower one would still have let a planted operator row block the
  migration despite the differing kind, defeating the namespace fix and P-A10.
  There is ONE uniqueness on this table and it is the triple). A REGISTRATION
  cannot retry: the trigger fires from a catalog row's INSERT, the catalog's
  primary key admits that INSERT exactly once for a consumer, and a second one
  is not a retry but an error the key already refuses. **And a present token
  must be a REAL one** (#580's review round 4, finding 5): `requestToken` is
  caller-supplied text — the reserved `sys:` prefix rules out a typed UUID — and
  a rule that rejects only NULL leaves `''` and whitespace-only strings as valid
  PERMANENT retry identities, so two unrelated operator calls that both send
  `''` collide and the second is replayed or refused as though it were the
  first. It therefore carries the SAME discipline `reason` and `actorId` carry —
  zod trims and requires length ≥ 1, and the CHECK rejects a value that is empty
  once every ASCII whitespace character is stripped — and joins P-A7's raw
  boundary probe with them. The whitespace rule was written twice in this
  document and applied to two of the three caller-supplied strings; the third
  was introduced in the same round that wrote the rule. The UNIQUE is `(consumer, actorKind, requestToken)` — **the KIND is part of
  the retry identity, not merely a column beside it** (#580's review round 3,
  finding 2) — and in PostgreSQL it admits any number of NULLs, so the baseline
  rows the registration trigger appends never contend on it. Round 2 made the
  `migration` kind token-carrying and left both kinds sharing one namespace, so
  an operator could supply a migration's PUBLIC name as their own token before
  that migration runs, and the migration would then either be REFUSED for a
  canonical-request mismatch — blocking a retryable deployment step on a
  database an operator can reach — or, if the operator copied the canonical
  fields too, REPLAY the operator's row as though it were its own, because
  `actorKind` took no part in the comparison. Keying the identity on the triple
  makes the two namespaces disjoint by construction. **Belt and braces at the
  surface**: the operator command refuses a `requestToken` carrying the reserved
  `sys:` prefix at zod, and every system token is minted with it, so the
  collision cannot be attempted through the supported path either — the trigger
  keeps the namespace, the surface keeps the manners. The row also carries
  the CANONICAL REQUEST the token was minted for (`active`, `reason`,
  `actorId`), so a replay can be CHECKED rather than assumed; see **The operator
  protocol**. Stating the nullability as one rule keeps this from reading like
  the contradiction finding 9 caught elsewhere: the token is mandatory for the
  writer that retries and absent for the writers that cannot.
- UPDATE and DELETE refused at the row, and the statement-level
  `OutboxConsumerActivation_t4d_no_truncate` registered in `TRUNCATE_SEALS`
  while the table stays outside every sanctioned reset (#560's review round 2,
  finding 2: a direct `TRUNCATE` would have erased the evidence and left the
  mirror unexplained). **NO deletion is admitted in production, and the test seam is a SANCTIONED
  RESET rather than a cascade** (#580's review round 3, finding 1, correcting
  round 2's finding 4). The FK is `ON DELETE RESTRICT` and the seal refuses
  every `DELETE`, direct or nested; since the catalog-INSERT trigger below gives
  EVERY consumer a head, a catalog row can no longer be deleted at all outside
  the seam. Round 2 gave the FK `ON DELETE CASCADE` and admitted the nested
  delete, reasoning that "when the catalog row is gone there is no mirror left
  to explain". **That reasoning was wrong**, and the trace is what shows it: the
  consumer NAME is reusable, `syncConsumerCatalog()` recreates it `active` by
  default at the next bootstrap, and the token receipts died with the row — so a
  lost operator request whose token was erased can EXECUTE AGAIN against the
  recreated consumer, and the consumer was excluded in the meantime with no
  attributable deactivation. A register whose evidence a plain parent delete can
  erase is not an evidence register.

  **And the cascade bought nothing, which the producer trace settles: NOTHING IN
  PRODUCTION DELETES A CATALOG ROW.** `apps/api/src`, `apps/api/prisma` and
  `scripts` contain no `outboxConsumerCatalog.delete` of any form —
  `syncConsumerCatalog` only creates, and no operator command removes a
  consumer. All ELEVEN deleters are integration teardowns:
  `outbox-scanner.test.ts` lines 51, 65, 108, 159, 175, 204, 230 and 250,
  `outbox-reliability.test.ts` lines 26 and 32, and
  `outbox-operations.test.ts` line 40 (#580's review round 4, finding 1 — round
  3 called its list complete at ten and it was not; a count is a claim, and this
  one is now the output of a search rather than a recollection). So round 2
  opened a production erasure path to serve test cleanup — the weaker of the two
  answers that finding offered, and the SECOND time this material has taken the
  weaker of two (the first was the state-only no-op over the token, #572 round
  9).

  **The stronger answer needs a helper that does not yet exist, and round 3
  named one that cannot do the job** (#580's review round 4, finding 4). Round 3
  said those sites "route their catalog cleanup through `sanctionedReset`". The
  delivered helper takes TABLE NAMES and executes `TRUNCATE TABLE <list>
  [CASCADE]` (`apps/api/prisma/sanctioned-reset.ts:106-121`): it has no
  row-scoped form at all. Applied to this problem it fails both ways — without
  `CASCADE` the truncate is refused by the new activation FK, and with `CASCADE`
  it erases EVERY catalog row including the `FILTERED` consumer
  `outbox-scanner.test.ts` needs for its remaining tests, so the suite stops
  materializing deliveries. Naming a delivered helper without reading it is the
  same defect as naming a seal with no installer, one layer down.

  So this unit specifies a NEW row-scoped sanctioned operation beside the
  existing one — `sanctionedConsumerRemoval(prisma, consumers)` in the same
  file, which in ONE transaction disables
  `OutboxConsumerActivation_t4d_append_only` by name in the delivered
  `DO $$ … IF EXISTS (SELECT 1 FROM pg_trigger …) … DISABLE TRIGGER` shape,
  deletes the activation rows for exactly the named consumers, deletes their
  catalog rows, and re-enables the seal. It is row-scoped because the fixtures
  are: `afterEach` removes an `AD_HOC` list while a long-lived consumer must
  survive, which a table-level truncate cannot express. The eleven sites call
  it; nothing else may. P-A6 asserts the halves that matter: a direct DELETE
  refused, a catalog-row DELETE refused while a head exists, the eleven
  teardowns succeeding through the new seam with every seal enabled afterwards,
  AND the long-lived consumer still present after a row-scoped removal of its
  neighbours — the arm that fails against a `CASCADE` truncate.
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

**The migration is in `migrate.sh`'s `ALWAYS_EXECUTE` list, or none of this
exists on a baseline** (#580's review round 4, finding 2). On a P3005/db-push
baseline `apps/api/scripts/migrate.sh` resolves every migration NOT named in
`ALWAYS_EXECUTE` as applied WITHOUT executing its SQL (the list at `:374`, the
check at `:476`). Everything this unit adds beyond Prisma-modelled columns — the
CHECKs, the BEFORE/AFTER triggers, the catalog-INSERT baseline trigger, the
rules trigger's seam, the backfill — is raw SQL, so on a production baseline it
would silently not exist while every probe that invokes the migration directly
still passes. This is the shape #572's round 8 finding 3 fixed for `20271015`,
and the extracted unit did not inherit it. The migration therefore joins
`ALWAYS_EXECUTE` by name, and P-A1 gains a BASELINE arm: the whole unit exercised
after a P3005 baseline run, RED with the entry removed — which is what makes the
list membership a tested fact rather than a line in a shell script nobody reads.

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

1. **A row for `(consumer, actorKind, requestToken)` exists** — the KIND is
   part of the identity, so an operator's token can never replay a migration's
   fact or be preempted by one (#580's review round 3, finding 2). Its stored canonical
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

## The delivered fixture surface this unit changes

Both seals this unit installs meet integration fixtures that write the catalog
directly today, and BOTH operations were traced, not just the one a finding
named (#580's review round 3, findings 1 and 3 — round 2 asked "which delivered
writers must still work" of the teardown DELETES and not of the activation
UPDATES in the same files, which is the same question one operation along):

| site | operation | disposition |
| --- | --- | --- |
| `outbox-scanner.test.ts` 51, 65, 108, 159, 175, 204, 230, 250 | catalog row DELETE | through the NEW row-scoped `sanctionedConsumerRemoval`, seal disabled by name; the production delete stays refused |
| `outbox-reliability.test.ts` 26, 32 | catalog row DELETE | the same seam |
| `outbox-operations.test.ts` 40 | catalog row DELETE | the same seam — the eleventh, missing from round 3's list (round 4, finding 1) |
| `outbox-scanner.test.ts` 171, 194, 198 | direct `active` UPDATE | converted to `outbox:consumer` protocol requests, each with its own token and a stated reason |
| `outbox-operations.test.ts` 122, 128 | direct `active` UPDATE | the same conversion, including the `// restore for later tests` flip at 128 |

The conversion is the point, not a workaround: these five UPDATEs are the only
places in the repository that flip a consumer's `active` outside the protocol,
and routing them through it means the focused suites exercise the SUPPORTED path
and the freeze has no exception carved for tests. The ten DELETEs cannot be
converted the same way — nothing in the protocol removes a consumer, because
nothing in production does — so they take the row-scoped sanctioned
removal specified above — which is NEW code in `sanctioned-reset.ts`, not the
existing `sanctionedReset`, whose table-level `TRUNCATE` cannot express "these
consumers and not that one" (round 4, finding 4).

## Probes

Executable, and each RED against its own defect alone:

| probe | asserts | RED against |
| --- | --- | --- |
| P-A1 | every catalog row holds exactly one `seq = 1` baseline row with the mirror equal to it, over a database holding history AND over a fresh one — **AND a consumer created AFTER the migration by `syncConsumerCatalog()` at bootstrap holds one too**, its `active` default mirrored and its `actorKind = 'registration'` | a backfill that seeds only pre-existing rows; one that runs before this migration's own registrations; and the ordering-only answer, under which the bootstrap-created row has no head at all |
| P-A2 | `outbox:consumer` issued TWICE with the same token and the SAME request appends exactly ONE fact; the mirror and `activationSeq` are unmoved on the second | the state-only no-op and the seq-carrying command |
| P-A3 | activate → (response lost) → a DIFFERENT operator deactivates → the first caller retries with its original token: the retry returns its ORIGINAL fact, the mirror stays INACTIVE, and no fact is appended — driven in BOTH starting states, from inactive AND **from a consumer that was ALREADY ACTIVE when the first request arrived** | round 9's state-only no-op, which re-activates and undoes the later intent, and the token-with-a-state-branch answer, which passes the first arm and fails the second because the confirming request recorded no token (#580's review round 1, finding 2) |
| P-A4 | activate → deactivate → activate, three distinct tokens, appends three facts | a token check that swallows genuine new intent |
| P-A5 | two concurrent operator requests with DISTINCT tokens, both flipping, staged as a PRE-LOCK rendezvous (#580's review round 2, finding 3 — round 1's staging said "both read the head before either commits", which the CORRECT implementation cannot do, because it takes the catalog row `FOR UPDATE` BEFORE that read: A would hold the lock at the barrier and B could never reach it, so the probe deadlocked against the very code it certifies): A opens, takes the lock, appends and HOLDS without committing; B then starts and is observed BLOCKED on that row in `pg_stat_activity`; A commits; B proceeds, reads the head A committed, and appends after it. BOTH facts commit, at `activationSeq + 1` and `+ 2` in the order they serialized, and the terminal mirror is the SECOND operator's intent | the head lock removed — without it both writers read the same head, both derive `+ 1`, the unique index admits one and REFUSES the other, and an operator's request is lost with the terminal state left at the first writer's. (RED by construction, unlike the earlier assertion — "exactly one commits at `activationSeq + 1`" — which `(consumer, seq)` UNIQUE guarantees with or without the lock, so it could not fail against lock removal at all: #580's review round 1, finding 7) |
| P-A6 | a direct UPDATE, a direct DELETE and a `TRUNCATE` on the register are each refused, and DELETING THE CATALOG ROW is refused too while a head exists — which is always, since the INSERT trigger gives every consumer one — so no production statement can erase a token receipt and let a lost request execute again against a recreated consumer; the ten delivered teardowns then succeed through the sanctioned-reset seam with this register's seal disabled by name and re-enabled after, asserted enabled at the end (#580's review round 3, finding 1 — RED against round 2's `ON DELETE CASCADE`, under which a plain catalog delete erases the register and `syncConsumerCatalog()` recreates the consumer active with its receipts gone); a direct UPDATE of `OutboxConsumerCatalog.active`, `activationSeq` or `registeredAt` refused at depth 1, one nested from another trigger without the marker refused, and the register's own AFTER INSERT admitted — while an event's obligation set is unchanged when `registeredAt` differs | the seals removed one at a time; an unconditional catalog freeze (under which every activation rolls back) and a depth-only one (under which any nested writer passes) |
| P-A7 | the WHITESPACE CHECK at the database boundary: a raw `INSERT` whose `reason` is a single space, a tab, a vertical tab, a form feed, a carriage return or a newline is refused, one arm of the CHECK removed at a time; the same for `actorId`; and the zod layer refused independently | a `btrim()`-only check, which passes every zod probe and still persists a tab-only reason from a direct writer (#580's review round 1, finding 10) |
| P-A8 | a raw `INSERT` naming a consumer with NO catalog row is refused — by the trigger's STRICT `NOT FOUND` raise, and again by the FK with the trigger disabled — and no orphan row survives | the non-STRICT lookup, under which the row commits with no mirror and a later registration collides with its history |
| P-A9 | a retry carrying a KNOWN token with a DIFFERENT `active`, a different `reason` or a different `actorId` is REFUSED naming the conflict, while the identical request replays; and an append with a blank or whitespace-only `actorId` is refused | a replay branch keyed on the token alone, which reports the earlier fact as this request's result |
| P-A10 | the CROSS-KIND collision (#580's review round 3, finding 2): an operator request carrying a migration's public name as its `requestToken` is refused at the surface by the reserved-prefix rule, and — planted directly past the surface — does NOT preempt the migration, which appends its own fact under its own kind and replays that fact on re-run; and an operator retry finds its own row and not the migration's | the single `(consumer, requestToken)` namespace, under which the migration is either refused for a canonical mismatch or replays the operator's row as its own |
| P-A11 | the delivered FIXTURE surface (#580's review round 3, findings 1 and 3): the five direct `active` UPDATEs converted to `outbox:consumer` requests (`outbox-scanner.test.ts` 171/194/198, `outbox-operations.test.ts` 122/128) drive their suites GREEN through the supported path, the same statements are REFUSED by the rules trigger when left direct, and the ELEVEN catalog-delete teardowns leave no row behind, with the long-lived `FILTERED` consumer still present after a row-scoped removal of its `AD_HOC` neighbours | the freeze installed without converting them, under which those focused suites fail on statements the plan never inspected |

`expandMissingDeliveries`, the delivery rows, the persisted catalog rules and
the obligation set are NOT in this unit — they stay in the 4d plan, which reads
the ACTIVE set from this register.

## Review round 4 (head `15e58c59`) — six findings; three are round 3's own

| # | classification | why that class |
|---|---|---|
| 1 | **regression introduced by a fix** | round 3's "all TEN deleters" was a count from recollection, not a search; there are eleven |
| 2 | **missed related path** | the extracted unit did not inherit `ALWAYS_EXECUTE` membership, which #572's round 8 finding 3 established for a sibling migration |
| 3 | **regression introduced by a fix** | round 3 added the three-column identity and left round 2's two-column sentence standing — two constraints, the narrower one defeating the fix |
| 4 | **regression introduced by a fix** | round 3 named `sanctionedReset` as the seam without reading it: it takes table names and TRUNCATEs |
| 5 | **missed related path** | the whitespace discipline was applied to `reason` and `actorId`, not to the third caller-supplied string this document introduced |
| 6 | **genuinely new** | the packet named the fork point as the base rather than the reviewed head's parent |

None duplicate, none incorrect; each reproduced against the repository before
acceptance.

**Finding 4 is the one that matters, and it is a repeat of a repeat.** Round 3
declined a cascade in favour of "a sanctioned seam" and named the delivered
`sanctionedReset` as that seam. It cannot be: it takes TABLE NAMES and executes
`TRUNCATE TABLE <list> [CASCADE]` (`sanctioned-reset.ts:106-121`). Without
`CASCADE` the truncate is refused by the very FK round 3 added; with `CASCADE`
it erases every catalog row including the consumer the suite still needs. So the
answer needs NEW code — a row-scoped `sanctionedConsumerRemoval` — and round 3
shipped a plan that pointed at a helper unable to do the job.

That is **naming a delivered helper without reading it**, which is the same
defect as naming a seal with no installer, one layer down. Findings 1 and 3 are
the same failure in smaller form: a count asserted from memory, and a superseded
sentence left standing beside its replacement. All three would have been caught
by the checks this plan family already carries — quote the thing you name, and
re-read what your edit supersedes — applied to my own new material rather than
to the material under review. This is the third round where that is the finding.

## Review round 3 (head `f586a64e`) — three findings, classified before correction

Worked under JagPat's instruction: classify, trace, move contract + inventory +
proof together, and answer a wrong finding with evidence rather than code.

| # | classification | why that class |
|---|---|---|
| 1 | **regression introduced by a fix** | round 2's finding 4 chose a parent CASCADE, which erases token receipts and lets a recreated consumer re-execute a lost request |
| 2 | **regression introduced by a fix** | round 2's finding 2 made `migration` token-carrying and left it sharing the operator namespace |
| 3 | **missed related path** | round 2 asked "which delivered writers must still work" of the teardown DELETES and never of the activation UPDATES in the same files |

None was a duplicate and none was incorrect; each was reproduced against the
repository before acceptance — the ten deleters and five updaters by search, the
namespace collision by reading the uniqueness against the protocol's own replay
branch.

**The trace is what decided finding 1, and it reversed my own answer.** Round 2
faced two options — a controlled test-only seam, or a production cascade — and
took the cascade, arguing that "when the catalog row is gone there is no mirror
left to explain". The producer trace shows why that is wrong twice over: the
consumer NAME is reusable and `syncConsumerCatalog()` recreates it active at the
next bootstrap, so the erased receipts still matter; and **nothing in production
deletes a catalog row at all** — `apps/api/src`, `apps/api/prisma` and `scripts`
have no such statement, and all ten deleters are integration teardowns. The
cascade therefore purchased test convenience with a production erasure path that
no production code needed. That is the second time this material has taken the
weaker of two offered answers (the first was the state-only no-op over the token
at #572's round 9), and it is worth naming as a habit rather than an incident:
**when a finding offers two answers and one is "restrict the production surface
and give tests a sanctioned seam", that is the one to take** — the other trades
a permanent capability for a temporary convenience.

Findings 1 and 3 land together because they are the same surface one operation
apart, and the plan now carries that surface as a table of its own — every
delivered site, its operation, and its disposition — rather than as a sentence
inside whichever seal happened to draw the finding.

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
| this task-bearing unit is not recorded in STATUS | #580 round 1, finding 1 | **FIXED at the time** — `open_pr: 580`, `task_state: in_progress`, the four-unit split named; **superseded by the 4d plan's round 22**, which returns this document to #572's unit, so STATUS records ONE open unit (`open_pr: 572`) and no separate entry is owed |
| `phase_plan` still named the completed 4c plan | #580 round 2, finding 1 | **FIXED** — it names the plan this change lands |
| the migration's replay token is refused by the register's own CHECK | #580 round 2, finding 2 | **FIXED** — the CHECK covers every retry-capable kind |
| P-A5's staging deadlocks against the correct implementation | #580 round 2, finding 3 | **FIXED** — pre-lock rendezvous with the blocked observation |
| the catalog-INSERT trigger breaks four delivered outbox teardowns | #580 round 2, finding 4 | **superseded** — the cascade it chose was itself an evidence-erasure path; see round 3, finding 1 |
| the eleventh catalog deleter was missing from a list called complete | #580 round 4, finding 1 | **FIXED** — `outbox-operations.test.ts:40`, found by search |
| the migration is not in `ALWAYS_EXECUTE`, so a baseline skips its raw SQL | #580 round 4, finding 2 | **FIXED** — named in the list, with a baseline probe arm |
| two token uniquenesses, the narrower defeating the namespace fix | #580 round 4, finding 3 | **FIXED** — one uniqueness, the triple |
| `sanctionedReset` cannot do row-scoped cleanup | #580 round 4, finding 4 | **FIXED** — a new `sanctionedConsumerRemoval` is specified instead |
| a blank or whitespace-only `requestToken` is a permanent retry identity | #580 round 4, finding 5 | **FIXED** — the same CHECK `reason` and `actorId` carry, plus the raw probe |
| the packet named the fork point as the base SHA | #580 round 4, finding 6 | **FIXED** — the reviewed head's parent, with the fork point kept as history |
| the parent cascade erases token receipts and lets a lost request execute again | #580 round 3, finding 1 | **FIXED** — no deletion in production (nothing there deletes a catalog row); the ten teardowns take the sanctioned-reset seam |
| an operator token can preempt or replay a migration's identity | #580 round 3, finding 2 | **FIXED** — the retry identity is `(consumer, actorKind, requestToken)`, with a reserved `sys:` prefix at the surface |
| five delivered fixtures write `active` directly and the freeze would refuse them | #580 round 3, finding 3 | **FIXED** — converted to `outbox:consumer` requests; the suites exercise the supported path |

## Review unit

This document has no review unit of its own any more: it is part of the 4d
plan's unit (PR #572), and that PR's packet carries the base SHA, the scope
figures and the marker trio for both documents together.

What the section said while this material was reviewed as PR #580, kept because
two of its lines are findings' answers:

- Base SHA: `e6fcc6c0` — the reviewed head's sole parent and the CURRENT
  comparison base at that time, `main` as it stood after #571 merged.
  (`15dd8eec` was that branch's fork point and was recorded as history only;
  naming it as the base described a broader, stale comparison than the two-file
  diff then under review — #580's review round 4, finding 6.)
- Scope: this plan document + `docs/STATUS.md`, which recorded the unit while it
  was open (#580's review round 1, finding 1). The STATUS entry it refers to is
  withdrawn on #572's branch, since a document that is not a separate unit is
  not a separate `open_pr`.
- Split considered: it WAS unit 1 of 4 extracted from #572; the split is
  reversed and the four units are one again (4d plan, round 22).
- Migration/service seam: n/a — docs-only
